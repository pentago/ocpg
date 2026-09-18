// ocpg - DB access layer for OpenCode persistent memory plugin.
import { SQL } from "bun";
import { Plugin } from "@opencode/plugin";

// --- DB config: env > defaults. Plugin options are not read; password is deliberately env-only (never in config).
const SSL_MODES = ["disable", "prefer", "require", "verify-ca", "verify-full"] as const;
type SslMode = (typeof SSL_MODES)[number];

type DbConfig = {
  host: string;
  port: number;
  user: string;
  database: string;
  ssl: SslMode;
};
type RecallArgs = { query?: string; limit?: number; tags?: string[]; global?: boolean };
type RememberArgs = {
  content: string;
  tags?: string[];
  type?: MemoryType;
};
type ForgetArgs = { id: number };
type UpdateArgs = { id: number; content: string; tags?: string[]; type?: MemoryType };

// Defaults to "disable" so the common localhost setup is unchanged; set OCPG_SSL
// when the database is remote, otherwise the SCRAM handshake crosses the network
// in plaintext.
function resolveSslMode(raw: string | undefined): SslMode {
  if (!raw) return "disable";
  const mode = raw.toLowerCase() as SslMode;
  return SSL_MODES.includes(mode) ? mode : "disable";
}

// Defaults resolved ONCE at module init - env-only, no process spawning.
const defaultConfig: DbConfig = {
  host: process.env.OCPG_HOST || "localhost",
  port: Number(process.env.OCPG_PORT) || 5432,
  user: process.env.OCPG_USER || "ocpguser",
  database: process.env.OCPG_DB || "ocpg",
  ssl: resolveSslMode(process.env.OCPG_SSL),
};
const password = process.env.OCPG_PASSWORD || "";

// Options-object constructor, not a URL string: Bun's SQL parses string URLs via
// url.parse(), which emits the DEP0169 DeprecationWarning at plugin load under opencode.
function makeSql(cfg: DbConfig): SQL {
  return new SQL({
    hostname: cfg.host,
    port: cfg.port,
    username: cfg.user,
    password,
    database: cfg.database,
    ssl: cfg.ssl,
    max: 2,
    // A dead database must fail fast: this pool is queried from the session
    // context hook, which sits in front of every model request.
    connectionTimeout: 3,
    idleTimeout: 30,
  });
}

const sql = makeSql(defaultConfig);

export interface MemoryRow {
  id: number;
  content: string;
  tags: string[] | null;
  project: string;
  date: string;
}

// Injected lines render each memory's origin project (memories are global),
// so the injection queries must select project; id is never rendered.
type InjectionRow = Pick<MemoryRow, "content" | "tags" | "date" | "project">;

// --- Rate-limited error logging ---

const lastLogTime = new Map<string, number>();

function rateLimitOk(kind: string): boolean {
  const now = Date.now();
  const last = lastLogTime.get(kind) ?? 0;
  if (now - last < 60_000) return false;
  lastLogTime.set(kind, now);
  return true;
}

// Test hook: the 60s rate-limit window is module state; tests clear it for determinism.
function resetRateLimit(): void {
  lastLogTime.clear();
}

// V2 plugins have no client.app.log; console.error from plugin code lands in the server log.
// Rate limiting is per kind so a failing recall does not mute injection errors.
function logError(kind: string, message: string): void {
  if (!rateLimitOk(kind)) return;
  console.error(`[ocpg] ${message}`);
}

// --- Query deadline ---

class DeadlineError extends Error {
  constructor(ms: number) {
    super(`query exceeded ${ms}ms deadline`);
    this.name = "DeadlineError";
  }
}

// Guards the injection query, which runs in front of every model request: a
// hung database must degrade to "no memories" rather than stall the turn.
//
// This races instead of cancelling. Bun documents query.cancel(), but on bun
// 1.4.2 it is a no-op for an in-flight Postgres query - verified against
// SELECT pg_sleep(5), which ran the full 5s under both .execute()+.cancel()
// and bare .cancel(). So the query is abandoned, not aborted: the caller is
// freed on time while the connection stays busy until the server finishes.
async function withDeadline<T>(query: PromiseLike<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new DeadlineError(ms)), ms);
  });
  // An abandoned query that later rejects would otherwise surface as an
  // unhandled rejection and take the process down.
  Promise.resolve(query).catch(() => {});
  try {
    return await Promise.race([query, deadline]);
  } finally {
    clearTimeout(timer);
  }
}

// --- Embeddings (hybrid retrieval: keyword + vector) ---

// bge-m3 via the host's Ollama (no container - the plugin calls it over HTTP,
// same pattern as the bench). Everything here degrades to keyword-only on any
// failure; embeddings can never break search. Env-only, resolved once at init
// like the DB config. The model name is an env var so it is swappable without
// a code change - a model with different dimensions needs the column re-created
// and a re-embed (deploy/README.md).
const OLLAMA_HOST = process.env.OCPG_OLLAMA_HOST || "localhost";
const OLLAMA_PORT = Number(process.env.OCPG_OLLAMA_PORT) || 11434;
const EMBED_MODEL = process.env.OCPG_EMBED_MODEL || "bge-m3";
let ollamaBase = `http://${OLLAMA_HOST}:${OLLAMA_PORT}`;

// Warm bge-m3 embed is ~20ms (measured 2026-09-18, RTX 5070); a cold model
// load is ~2-3s, over the injection deadline - so setup() fires a warm-up and
// every request passes keep_alive to keep the model resident. The query budget
// only trips when racing that warm-up or a wedged daemon, and both fall back
// to keyword-only. The write path is fire-and-forget and tolerates cold loads.
const EMBED_QUERY_TIMEOUT_MS = 750;
const EMBED_WRITE_TIMEOUT_MS = 15_000;
// Candidate slice per hybrid half, mirroring the keyword LIMIT 20.
const EMBED_CANDIDATES = 20;

// Never rejects: any failure (daemon down, model missing, timeout) logs
// rate-limited and returns null, and the caller runs keyword-only.
async function embed(texts: string[], timeoutMs: number): Promise<number[][] | null> {
  try {
    const res = await fetch(`${ollamaBase}/api/embed`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      // keep_alive pins the model: the default 5m unload would make the first
      // query after any idle gap pay the ~2-3s cold load and lose to the timeout.
      body: JSON.stringify({ model: EMBED_MODEL, input: texts, keep_alive: "30m" }),
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!res.ok) throw new Error(`ollama /api/embed ${EMBED_MODEL}: HTTP ${res.status}`);
    return ((await res.json()) as { embeddings: number[][] }).embeddings;
  } catch (e: unknown) {
    logError("embed", `ocpg embedding unavailable, keyword-only: ${e instanceof Error ? e.message : String(e)}`);
    return null;
  }
}

// pgvector literal, e.g. "[0.1,-0.2,...]", sent as a text param cast to vector.
function vectorLiteral(v: number[]): string {
  return `[${v.join(",")}]`;
}

// Reciprocal rank fusion (k=60, the standard constant): a row scores
// 1/(60 + 1-based rank) in each list it appears in, so a hit in both lists
// outranks either list's tail. Keyed on content - identical text is the same
// memory. Bench-verified (hybrid-rrf, bench/README.md): recall >= both the
// keyword and the embedding parent at 485/5k/50k rows.
function rrfMerge<T extends { content: string }>(lists: T[][], k = 60): T[] {
  const scores = new Map<string, { score: number; row: T }>();
  for (const list of lists) {
    list.forEach((row, i) => {
      const entry = scores.get(row.content) ?? { score: 0, row };
      entry.score += 1 / (k + i + 1);
      scores.set(row.content, entry);
    });
  }
  // Map preserves insertion order and Array.sort is stable, so fused-score
  // ties keep the keyword list's order (it is always merged first).
  return [...scores.values()].sort((a, b) => b.score - a.score).map((e) => e.row);
}

// The shipped hybrid composition (bench/rrf-slots.ts): the vector list's top
// `reserved` rows are UNCONDITIONAL, the rest is the RRF merge minus the
// picks. Plain RRF alone dilutes vector hits when the keyword half is noisy
// on the real corpus (equal-weight ties favor keyword-listed rows, and
// weighting the vector side does not help - rows present in both lists are
// boosted at any weight). R=2 was the free knee: real paraphrase hit@5
// 8/20 -> 12/20 with zero measurable synthetic cost (R=3: 13/20 but the first
// direct-recall regression, and 3/5 of the block can be nearest-neighbor
// noise on no-signal prompts). reserved=0 or an empty vector list degenerates
// to the plain merge, so the keyword-only fallbacks need no special case.
function hybridMerge<T extends { content: string }>(keywordRows: T[], vectorRows: T[], reserved = 2): T[] {
  const picked = vectorRows.slice(0, reserved);
  const rest = rrfMerge([keywordRows, vectorRows]).filter((r) => !picked.some((p) => p.content === r.content));
  return [...picked, ...rest];
}

// Off the write path: embed one memory and store its vector. Never throws -
// callers fire-and-forget it, so every failure (Ollama down, missing column)
// lands here. A row whose embedding stays NULL is keyword-only until the
// backfill (deploy/backfill.ts) or a later memory_update fills it.
async function embedAndStore(id: number, content: string): Promise<void> {
  try {
    const vecs = await embed([content], EMBED_WRITE_TIMEOUT_MS);
    if (!vecs) return;
    await sql`UPDATE memories SET embedding = ${vectorLiteral(vecs[0])}::vector WHERE id = ${id}`;
  } catch (e: unknown) {
    logError("embed-write", `ocpg embedding store failed for #${id}: ${e instanceof Error ? e.message : String(e)}`);
  }
}

// --- Injection pipeline ---

// Injection ranking mode (plan follow-up: relevance over blind recency).
// "relevance" (default) scores all memories - every project - against the
// user's latest prompt via full-text search, falling back to recency when the
// prompt matches nothing; "recency" restores the old last-5 behavior via
// OCPG_INJECTION=recency. Resolved once at init, env-only.
let injectionMode: "relevance" | "recency" =
  process.env.OCPG_INJECTION === "recency" ? "recency" : "relevance";

function truncateMemory(content: string): string {
  if (content.length <= 600) return content;
  return `${content.slice(0, 600)}…[truncated]`;
}

// Memory content is interpolated verbatim into the system prompt; a stored
// memory containing the closing tag would otherwise end the block early and
// have its remainder read as top-level instructions.
function sanitizeMemory(content: string): string {
  return content.replaceAll("</persistent-project-memory>", "");
}

// Approximates pg_trgm similarity in TS: character-trigram Jaccard. Used only
// to collapse near-duplicate rows out of the injection candidates (the
// candidate set is tiny), never for storage decisions.
function trigrams(text: string): Set<string> {
  const s = text.toLowerCase().replace(/\s+/g, " ");
  const out = new Set<string>();
  for (let i = 0; i < s.length - 2; i++) out.add(s.slice(i, i + 3));
  return out;
}

function nearDupe(a: string, b: string): boolean {
  return nearDupeSets(trigrams(a), trigrams(b));
}

function nearDupeSets(A: Set<string>, B: Set<string>): boolean {
  if (A.size === 0 || B.size === 0) return false;
  let inter = 0;
  for (const t of A) if (B.has(t)) inter++;
  return inter / (A.size + B.size - inter) >= DEDUP_SIMILARITY;
}

// Injection fetches a deeper candidate slice (rank-ordered) and greedily drops
// rows that near-dupe an already-kept row, emitting the top 5. Without this,
// duplicate writes (there is no write-time rejection) would fill the 5 slots
// with restatements of one fact.
function collapseDupes(rows: InjectionRow[]): InjectionRow[] {
  const kept: InjectionRow[] = [];
  for (const row of rows) {
    if (kept.length >= 5) break;
    if (!kept.some((k) => nearDupe(k.content, row.content))) kept.push(row);
  }
  return kept;
}

function formatBlock(rows: InjectionRow[], projectDir: string): string {
  if (rows.length === 0) return "";
  const lines: string[] = [
    "<persistent-project-memory>",
    `Project: ${projectDir}`,
    "Memories:",
  ];
  for (const row of rows) {
    const tags = row.tags ?? [];
    const tagStr = tags.length ? ` [${tags.join(", ")}]` : "";
    // Origin project matters now that memories are shared: basename keeps the
    // injected line short.
    const origin = row.project.split('/').pop() ?? row.project;
    lines.push(`- [${row.date}] (${origin})${tagStr} ${sanitizeMemory(truncateMemory(row.content))}`);
  }
  lines.push("");
  lines.push(
    "Before non-trivial work, check these. After user corrections, architecture decisions, or non-trivial fixes, call memory_remember. Use memory_recall to search past lessons.",
  );
  lines.push("</persistent-project-memory>");
  return lines.join("\n");
}

// Keyed by directory + prompt hash now that the block depends on the prompt
// (relevance mode): an identical prompt (model retries, re-requests) hits the
// cache; a new prompt queries afresh. An empty string is cached for
// no-match/empty prompts so they stop re-querying.
const injectionCache = new Map<string, string>();

// djb2 - just a stable key shortener; a same-hash different-prompt collision
// would serve a stale block, which remember/forget invalidation clears.
function hashQuery(text: string): string {
  let h = 5381;
  for (let i = 0; i < text.length; i++) h = ((h << 5) + h + text.charCodeAt(i)) | 0;
  return (h >>> 0).toString(36);
}

// The latest user message is the retrieval signal: what the user is asking
// about right now is the best proxy for which memories matter. Text parts
// only; capped because a query is a query, not a transcript - FTS is not
// helped by thousands of characters.
function extractPromptQuery(
  messages: ReadonlyArray<{ role: unknown; content: ReadonlyArray<{ type?: unknown; text?: unknown }> }>,
): string {
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i];
    if (message?.role !== "user") continue;
    const text = message.content
      .filter((p) => p.type === "text" && typeof p.text === "string")
      .map((p) => p.text as string)
      .join(" ")
      .trim();
    return text.length > 512 ? text.slice(0, 512) : text;
  }
  return "";
}

// Visibility rule shared by recall and both injection builders: global types
// (preference, stack_fact) are visible everywhere; project_fact is visible
// only from its origin project unless explicitly opted out with
// global: true (recall) - at injection time there is no caller to opt in, so
// other projects' project_fact rows never surface as ambient context.
function visibleRows(client: SQL, directory: string) {
  return client`(memory_type != 'project_fact' OR project = ${directory})`;
}

// Recency query shared by the recency mode and the no-match fallback: latest
// visible rows, preferences first. Global by design - the project column
// records origin, not visibility... for global types; project_fact is
// origin-scoped (see visibleRows).
// Query builders are pure functions of the client so the benchmark
// (bench/run.ts) can execute the EXACT production SQL against bench
// databases - no drift between what is measured and what runs.
function buildRecencyQuery(client: SQL, directory: string) {
  // LIMIT 20: a candidate slice for collapseDupes, not the final block.
  return client`
    SELECT content, coalesce(tags, '{}') AS tags,
           to_char(created_at, 'YYYY-MM-DD') AS date,
           project
    FROM memories
    WHERE ${visibleRows(client, directory)}
    ORDER BY (memory_type = 'preference') DESC, created_at DESC
    LIMIT 20
  `;
}

function buildRelevanceQuery(client: SQL, tsQuery: string, directory: string) {
  // Relevance: full-text search over every visible memory - global types
  // from anywhere, project_fact from the origin project - with a small
  // same-project boost to break rank ties toward locally stored memories.
  return client`
    SELECT content, coalesce(tags, '{}') AS tags,
           to_char(created_at, 'YYYY-MM-DD') AS date,
           project
    FROM memories
    WHERE search_vector @@ to_tsquery('english', ${tsQuery})
      AND ${visibleRows(client, directory)}
    ORDER BY ts_rank(search_vector, to_tsquery('english', ${tsQuery}))
             + (CASE WHEN project = ${directory} THEN 0.01 ELSE 0 END) DESC,
             created_at DESC
    LIMIT 20
  `;
}

// Vector half of the hybrid: nearest neighbors by cosine distance over the
// same visibility rules as the keyword half. Unlike FTS this always returns
// rows when embedded rows exist (nearest is always *something*), so the
// caller merges it via rrfMerge - and the recency fallback stays for the
// "no retrieval signal at all" case. Fails on a database without the
// embedding column; the caller catches and runs keyword-only.
function buildVectorQuery(client: SQL, vectorLit: string, directory: string) {
  return client`
    SELECT content, coalesce(tags, '{}') AS tags,
           to_char(created_at, 'YYYY-MM-DD') AS date,
           project
    FROM memories
    WHERE embedding IS NOT NULL
      AND ${visibleRows(client, directory)}
    ORDER BY embedding <=> ${vectorLit}::vector
    LIMIT ${EMBED_CANDIDATES}
  `;
}

// The prompt as an OR of stemmed words: websearch_to_tsquery ANDs the terms,
// so one word the memory never uses would zero out the whole query (bench:
// recall 0.00-0.02 on multi-word queries). OR ranks by how many (and how
// rare) the matched terms are, and sanitizing to [a-z0-9]+ tokens keeps
// to_tsquery syntax-safe. Capped at 24 words to bound the query.
function orTsQuery(text: string): string {
  const words = text.toLowerCase().match(/[a-z0-9]+/g) ?? [];
  return words.slice(0, 24).join(" | ");
}

// The block depends on the directory plus (in relevance mode) the prompt,
// passed explicitly by the caller.
async function handleTransform(
  output: { system: string[] },
  directory: string,
  prompt = "",
): Promise<void> {
  if (!directory) return;
  const query = injectionMode === "relevance" ? prompt.trim() : "";
  const cacheKey = `${directory}\u0001${hashQuery(query)}`;
  const cached = injectionCache.get(cacheKey);
  if (cached !== undefined) {
    if (cached) output.system.push(cached);
    return;
  }
  try {
    let rows: InjectionRow[];
    const tsQuery = orTsQuery(query);
    if (tsQuery) {
      // Hybrid: the keyword half always runs; the embedding half is started
      // concurrently so a warm bge-m3 (~20ms) hides behind the keyword
      // round-trip. Null embedding (Ollama down/timeout) or a failed vector
      // query (pre-migration database, DeadlineError) degrade to keyword-only.
      const embedding = embed([query], EMBED_QUERY_TIMEOUT_MS);
      const keywordRows = await withDeadline(
        buildRelevanceQuery(sql, tsQuery, directory) as unknown as PromiseLike<InjectionRow[]>,
        1000,
      );
      rows = keywordRows;
      const vecs = await embedding;
      if (vecs) {
        const vectorRows = await withDeadline(
          buildVectorQuery(sql, vectorLiteral(vecs[0]), directory) as unknown as PromiseLike<InjectionRow[]>,
          1000,
        ).catch((e: unknown) => {
          logError("embed-query", `ocpg vector query failed, keyword-only: ${e instanceof Error ? e.message : String(e)}`);
          return null;
        });
        if (vectorRows) rows = hybridMerge(keywordRows, vectorRows);
      }
      if (rows.length === 0) {
        // No retrieval signal at all for this prompt - recency beats an empty
        // block. The vector half alone counts as a signal: a zero-overlap
        // paraphrase is exactly what embeddings are for.
        rows = await withDeadline(buildRecencyQuery(sql, directory) as unknown as PromiseLike<InjectionRow[]>, 1000);
      }
    } else {
      rows = await withDeadline(buildRecencyQuery(sql, directory) as unknown as PromiseLike<InjectionRow[]>, 1000);
    }
    const block = formatBlock(collapseDupes(rows), directory);
    // Evict oldest entry when cache exceeds 32
    if (injectionCache.size >= 32) {
      const firstKey = injectionCache.keys().next().value;
      if (firstKey !== undefined) injectionCache.delete(firstKey);
    }
    injectionCache.set(cacheKey, block);
    if (block) output.system.push(block);
  } catch (e: unknown) {
    logError("inject", `ocpg injection failed: ${e instanceof Error ? e.message : String(e)}`);
  }
}

// --- Dispose ---

// One opencode process evaluates this module once but runs setup() once per
// project location, so instances share the pool. Verified against opencode
// v2.0.3: four locations were live in a single pid with one module instance.
// Without the refcount, a config change in one project disposes that instance
// and closes the pool out from under every other live project.
let instances = 0;

function retain(): void {
  instances++;
}

async function dispose(): Promise<void> {
  if (instances > 0) instances--;
  if (instances > 0) return;
  await sql.close().catch(() => {});
}

// --- Agent tools: recall + remember with dedup-on-write ---

// Write caps: these are abuse guards, not style rules. Measured against a real
// 485-memory corpus (p95 content 517 chars, p95 5 tags, longest tag 26 chars),
// so ordinary memories never come close.
const MAX_CONTENT = 4000;
const MIN_CONTENT = 10;
const MAX_TAGS = 10;
const MAX_TAG_LENGTH = 64;

// --- Memory types (plan 2.1: defaulted, never required) ---

// The stored vocabulary mirrors the DB CHECK constraint (memories_type_check);
// rows predate the column, so "required" would break every existing caller -
// type is always defaulted. Visibility follows the type: preference and
// stack_fact are global (tooling knowledge ports across every project using
// the stack), project_fact is origin-project-only (customer-specific facts
// must not surface elsewhere), episodic is reserved for the (cut, opt-in) 1.3
// feature; remember accepts it so the vocabulary stays in one place.
const MEMORY_TYPES = ["preference", "stack_fact", "project_fact", "episodic"] as const;
type MemoryType = (typeof MEMORY_TYPES)[number];

function resolveMemoryType(raw: unknown): MemoryType {
  return MEMORY_TYPES.includes(raw as MemoryType) ? (raw as MemoryType) : "project_fact";
}

// Raw JSON Schema input is not coerced for us: a model sending "3" or null for
// limit would otherwise reach Postgres as LIMIT NaN.
function resolveLimit(raw: unknown): number {
  const n = Number(raw);
  if (!Number.isFinite(n)) return 5;
  return Math.min(Math.max(Math.trunc(n), 1), 20);
}

// The model sees a generic failure; the operator sees the real message in the
// server log. Raw driver errors carry host, user and schema details that should
// not end up in a transcript sent to the provider.
function toolError(kind: string, action: string, e: unknown): string {
  logError(kind, `ocpg ${action} failed: ${e instanceof Error ? e.message : String(e)}`);
  // 42883 = undefined_function. The only way to hit it here is a database
  // without pg_trgm, which is worth naming: the fix is one statement and the
  // generic message would send the operator hunting.
  if (String((e as { errno?: unknown })?.errno) === "42883") {
    return "ERROR: this database is missing the pg_trgm extension, which memory_remember needs for duplicate detection. Run: CREATE EXTENSION pg_trgm;";
  }
  return `ERROR: memory store unavailable (${action} failed; see opencode server log).`;
}

async function recall(
  args: RecallArgs,
  ctx: { directory: string },
): Promise<string> {
  try {
    const limit = resolveLimit(args.limit);
    // Visibility: global types (preference, stack_fact) everywhere;
    // project_fact only from the origin project unless the caller opts in
    // with global: true.
    const visibleCond = args.global ? sql`` : sql`AND ${visibleRows(sql, ctx.directory)}`;
    const q = args.query ?? "";
    const tsQuery = q ? orTsQuery(q) : "";
    const queryCond = q
      ? sql`AND search_vector @@ to_tsquery('english', ${tsQuery})`
      : sql``;
    // Tags are not part of search_vector (it covers content only), so they are
    // unreachable by query alone. Matches rows carrying ALL the given tags,
    // served by idx_memories_tags.
    const tagList = Array.isArray(args.tags) ? args.tags.filter((t) => typeof t === "string" && t) : [];
    const tagCond = tagList.length
      ? sql`AND tags @> ${sql.array(tagList, "text")}`
      : sql``;
    // Relevance-ranked when searching; undirected browse is plain recency
    // (preferences first, matching the injection fallback). A frequency blend
    // was tried and removed: bumping exactly the returned top-5 is a
    // rich-get-richer loop - live corpus rows pinned the top slot after a few
    // runs. access_count stays as data collection; no ranking consumes it.
    const orderBy = q
      ? sql`ORDER BY ts_rank(search_vector, to_tsquery('english', ${tsQuery})) DESC`
      : sql`ORDER BY (memory_type = 'preference') DESC, created_at DESC`;

    // Hybrid: with a searchable query, embed it concurrently so a warm bge-m3
    // (~20ms) hides behind the keyword round-trip; the vector half then merges
    // via RRF. Any embedding failure (Ollama down, no embedding column yet)
    // degrades to exactly the pre-hybrid keyword-only behavior.
    const embedding = tsQuery ? embed([q], EMBED_QUERY_TIMEOUT_MS) : Promise.resolve(null);
    // A directed query fetches a candidate slice for the RRF merge; the
    // caller's limit is applied after. Browse keeps its plain LIMIT.
    const keywordRows = await sql`
      SELECT id, content, coalesce(tags, '{}') AS tags,
             to_char(created_at, 'YYYY-MM-DD') AS date,
             project, memory_type
      FROM memories
      WHERE 1=1 ${visibleCond} ${queryCond} ${tagCond}
      ${orderBy}
      LIMIT ${q ? EMBED_CANDIDATES : limit}
    ` as (MemoryRow & { memory_type: string })[];

    let rows = keywordRows;
    const vecs = await embedding;
    if (vecs) {
      // Same filters as the keyword half, minus the FTS condition.
      const vectorRows = await (sql`
        SELECT id, content, coalesce(tags, '{}') AS tags,
               to_char(created_at, 'YYYY-MM-DD') AS date,
               project, memory_type
        FROM memories
        WHERE embedding IS NOT NULL ${visibleCond} ${tagCond}
        ORDER BY embedding <=> ${vectorLiteral(vecs[0])}::vector
        LIMIT ${EMBED_CANDIDATES}
      ` as unknown as Promise<(MemoryRow & { memory_type: string })[]>).catch((e: unknown) => {
        logError("embed-query", `ocpg vector query failed, keyword-only: ${e instanceof Error ? e.message : String(e)}`);
        return null;
      });
      if (vectorRows) {
        // Reserved slots never exceed half the result: at limit 1-2 the plain
        // merge decides, so a direct query's exact keyword hit cannot be
        // displaced by a merely-adjacent vector row.
        rows = hybridMerge(keywordRows, vectorRows, Math.min(2, Math.floor(limit / 2)));
      }
    }
    if (q) rows = rows.slice(0, limit);

    // Access ranking is recall-only (plan 2.2): the injection path stays
    // read-only because its per-directory cache would make increments biased.
    // Fire-and-forget so the UPDATE never sits on the read path's latency.
    const ids = rows.map((r) => r.id);
    if (ids.length > 0) {
      void sql`UPDATE memories SET access_count = access_count + 1, last_accessed_at = now() WHERE id = ANY(${sql.array(ids, "int8")})`.catch(
        (e: unknown) => logError("access", `ocpg access bump failed: ${e instanceof Error ? e.message : String(e)}`),
      );
    }

    if (rows.length === 0) return "No memories found.";

    return rows
      .map((r) => {
        const tags = r.tags ?? [];
        const tagStr = tags.length ? ` (${tags.join(', ')})` : '';
        // preference/episodic are worth surfacing; project_fact is the default
        // every pre-column row carries, so printing it is pure noise.
        const typeStr = r.memory_type === "project_fact" ? "" : ` [${r.memory_type}]`;
        return `[${r.date}] [${r.project}]${typeStr}${tagStr}\n#${r.id}\n${r.content}`;
      })
      .join('\n---\n');
  } catch (e: unknown) {
    return toolError("recall", "recall", e);
  }
}

// Rejects rather than truncates: a clipped memory loses its tail silently,
// while an error reports the actual size and lets the agent retry shorter.
function validateWrite(args: RememberArgs): string | null {
  const content = typeof args.content === "string" ? args.content : "";
  if (content.length < MIN_CONTENT) {
    return `ERROR: content must be at least ${MIN_CONTENT} characters.`;
  }
  if (content.length > MAX_CONTENT) {
    return `ERROR: content is ${content.length} characters, max ${MAX_CONTENT}; store the essentials in 1-3 sentences and retry.`;
  }
  const tags = args.tags ?? [];
  if (!Array.isArray(tags)) return "ERROR: tags must be an array of strings.";
  if (tags.length > MAX_TAGS) {
    return `ERROR: ${tags.length} tags given, max ${MAX_TAGS}.`;
  }
  const oversized = tags.find((t) => typeof t !== "string" || t.length > MAX_TAG_LENGTH);
  if (oversized !== undefined) {
    return `ERROR: each tag must be a string of at most ${MAX_TAG_LENGTH} characters.`;
  }
  if (args.type !== undefined && !MEMORY_TYPES.includes(args.type)) {
    return `ERROR: type must be one of ${MEMORY_TYPES.join(", ")}.`;
  }
  return null;
}

// Trigram similarity threshold for near-duplicate handling (consolidation and
// the injection collapse pass). Measured on a real 485-memory corpus: 0.8 is
// strict enough that only restatements collide. Writes never reject on it -
// duplicates are cleaned up by memory_consolidate and collapsed out of the
// injected block.
const DEDUP_SIMILARITY = 0.8;

async function remember(
  args: RememberArgs,
  ctx: { directory: string; sessionID: string },
): Promise<string> {
  try {
    const invalid = validateWrite(args);
    if (invalid) return invalid;

    // Tags are stored verbatim - the project column records origin, not visibility.
    const tags = args.tags ?? [];
    const basename = ctx.directory.split('/').pop() ?? ctx.directory;

    // sql.array(tags) alone encodes text[] with quoted elements under bun 1.4.2;
    // the element type hint is required for clean array storage.
    const inserted = await sql`
      INSERT INTO memories (content, tags, session_id, project, memory_type)
      VALUES (${args.content}, ${sql.array(tags, "text")}, ${ctx.sessionID}, ${ctx.directory}, ${resolveMemoryType(args.type)})
      RETURNING id
    ` as { id: number }[];

    // Fire-and-forget embedding (hybrid retrieval): never blocks the
    // confirmation. A failure leaves embedding NULL - keyword search keeps
    // working; the backfill (deploy/backfill.ts) fills the gap later.
    void embedAndStore(inserted[0].id, args.content);

    // The injection block is global, but its cache is keyed by the calling
    // directory + prompt; clear the directory's keys.
    invalidateInjection(ctx.directory);
    return `Stored memory #${inserted[0].id} (project ${basename}).`;
  } catch (e: unknown) {
    return toolError("remember", "remember", e);
  }
}

// --- Keyword capture (plan 1.1, revised) ---

// Deterministic capture, no LLM: a trigger phrase in the prompt stores the text
// following it verbatim (minus the trigger) through the normal write path.
// Extracting "relevant content" instead would be a model judgment on the
// prompt-admission path - nondeterministic, and it violates the project rule
// that model judgment never becomes load-bearing (memory #1555).
const MEMORY_TRIGGER_RE =
  /\b(?:remember(?:\s+(?:this|that|to))?|do(?:n'?| no)t forget(?:\s+(?:this|that|to))?|keep (?:this|that )?in mind(?: that)?)\b\s*[:,]?\s*/i;

// Interrogative follow-ons are questions about the past ("remember when the
// pool broke?"), not storage requests. The list is deliberately narrow:
// "remember that when X happens, do Y" is imperative and must be captured, so
// "when" alone is not enough - only skip the bare question forms.
const INTERROGATIVE_RE = /^(?:when|what|where|why|how|who|whom|whose|which|did)\b/i;

function extractMemoryRequest(text: string): string | null {
  const match = MEMORY_TRIGGER_RE.exec(text);
  if (!match) return null;
  const rest = text.slice(match.index + match[0].length).trim();
  if (!rest || INTERROGATIVE_RE.test(rest)) return null;
  return rest;
}

// Fire-and-forget by design: prompt admission must not wait on a database
// write, and the prompt itself is never mutated on failure.
//
// Not exactly-once: the docs allow prompt hooks to run more than once under
// concurrent submissions. Dedup-on-write (trigram similarity) is the guard -
// no hook-side deduplication layer on top of it.
async function captureFromPrompt(
  text: string,
  directory: string,
  sessionID: string,
): Promise<void> {
  const content = extractMemoryRequest(text);
  if (!content) return;
  try {
    await remember({ content, tags: ["user-requested"] }, { directory, sessionID });
  } catch (e: unknown) {
    logError("capture", `ocpg keyword capture failed: ${e instanceof Error ? e.message : String(e)}`);
  }
}

// project_fact rows are origin-scoped (a customer-B agent must not delete
// customer-A's customer facts); global types (preference, stack_fact) are
// maintainable from any project - that's what global means for them.
async function forget(
  args: ForgetArgs,
  ctx: { directory: string },
): Promise<string> {
  try {
    const id = Number(args.id);
    if (!Number.isInteger(id) || id <= 0) {
      return "ERROR: id must be a positive integer (the #id shown by memory_recall).";
    }
    const deleted = await sql`
      DELETE FROM memories
      WHERE id = ${id} AND ${visibleRows(sql, ctx.directory)}
      RETURNING id
    ` as { id: number }[];

    if (deleted.length === 0) {
      const exists = await sql`SELECT project, memory_type FROM memories WHERE id = ${id}` as { project: string; memory_type: string }[];
      if (exists.length > 0) {
        return `Memory #${id} is a ${exists[0].memory_type} belonging to ${exists[0].project}; not deleted. Only that project's agent can delete it.`;
      }
      return `No memory #${id}; nothing deleted.`;
    }
    invalidateInjection(ctx.directory);
    return `Deleted memory #${id}.`;
  } catch (e: unknown) {
    return toolError("forget", "forget", e);
  }
}

// No dedup fall-through, by design: an update that lands close to another
// memory is an intentional correction, not a dupe to reject. updated_at is
// set; created_at is deliberately NOT bumped - the displayed date must keep
// saying when the memory was learned, not when it was last edited. Omitted
// tags/type are preserved, not reset to their defaults.
async function updateMemory(
  args: UpdateArgs,
  ctx: { directory: string },
): Promise<string> {
  try {
    const id = Number(args.id);
    if (!Number.isInteger(id) || id <= 0) {
      return "ERROR: id must be a positive integer (the #id shown by memory_recall).";
    }
    const invalid = validateWrite(args);
    if (invalid) return invalid;

    const tags = args.tags ?? [];
    const tagCond = Array.isArray(args.tags)
      ? sql`tags = ${sql.array(tags, "text")},`
      : sql``;
    const typeCond = args.type !== undefined
      ? sql`memory_type = ${resolveMemoryType(args.type)},`
      : sql``;
    const updated = await sql`
      UPDATE memories
      SET content = ${args.content},
          ${tagCond}
          ${typeCond}
          updated_at = now()
      WHERE id = ${id} AND ${visibleRows(sql, ctx.directory)}
      RETURNING id
    ` as { id: number }[];

    if (updated.length === 0) {
      const exists = await sql`SELECT project, memory_type FROM memories WHERE id = ${id}` as { project: string; memory_type: string }[];
      if (exists.length > 0) {
        return `Memory #${id} is a ${exists[0].memory_type} belonging to ${exists[0].project}; not updated. Only that project's agent can edit it.`;
      }
      return `No memory #${id}; nothing updated.`;
    }
    invalidateInjection(ctx.directory);
    // Content changed, so the embedding must follow - same fire-and-forget
    // path as remember.
    void embedAndStore(id, args.content);
    return `Updated memory #${id}.`;
  } catch (e: unknown) {
    return toolError("update", "update", e);
  }
}

// Deterministic consolidation, no model calls inside the plugin: find
// near-duplicate clusters (trigram similarity >= DEDUP_SIMILARITY over the
// whole content, global), keep the newest of each, delete the rest. The
// deleted texts are returned verbatim so the CALLING agent - itself a model -
// can merge any unique fact back into the survivor via memory_update. Merging
// is language synthesis, which is the caller's job, not the plugin's.
// Runs on demand (user-invoked), never on a schedule; capped at 25 clusters
// per run so a wildly-duplicated corpus cannot turn into one huge report.
async function consolidate(): Promise<string> {
  try {
    const rows = await sql`
      SELECT id, content, coalesce(tags, '{}') AS tags, created_at
      FROM memories
      ORDER BY created_at DESC
    ` as { id: number; content: string; tags: string[]; created_at: Date }[];

    // Greedy clustering newest-first: each row joins the first cluster whose
    // representative (the newest member) it near-dupes. Trigram sets are built
    // once (rebuilding per comparison made consolidate O(n^2) set-constructions,
    // seconds at 5k rows), and a size-ratio prefilter skips pairs whose Jaccard
    // can never reach the threshold.
    type Entry = { row: (typeof rows)[number]; set: Set<string> };
    const entries: Entry[] = rows.map((row) => ({ row, set: trigrams(row.content) }));
    const clusters: Array<Array<Entry>> = [];
    for (const entry of entries) {
      const host = clusters.find((c) => {
        const ra = c[0].set.size;
        const rb = entry.set.size;
        // Jaccard >= 0.8 is impossible when one set is much smaller; the
        // comparison itself is the expensive part, so prefilter on sizes.
        if (ra === 0 || rb === 0 || ra > rb * 4 || rb > ra * 4) return false;
        return nearDupeSets(c[0].set, entry.set);
      });
      if (host) host.push(entry);
      else clusters.push([entry]);
    }

    const multi = clusters.filter((c) => c.length > 1).slice(0, 25);
    if (multi.length === 0) return "No duplicates found; nothing to consolidate.";

    let removed = 0;
    const report: string[] = [];
    for (const cluster of multi) {
      const survivor = cluster[0].row;
      const removedRows = cluster.slice(1).map((e) => e.row);
      for (const r of removedRows) {
        await sql`DELETE FROM memories WHERE id = ${r.id}`;
      }
      removed += removedRows.length;
      // Show what died so the calling agent can merge unique facts back into
      // the survivor.
      report.push(
        `Kept #${survivor.id}: ${truncateMemory(survivor.content)}\n` +
          removedRows.map((r) => `  removed #${r.id}: ${truncateMemory(r.content)}`).join("\n"),
      );
    }

    if (removed > 0) injectionCache.clear();
    return (
      `Removed ${removed} duplicate ${removed === 1 ? "memory" : "memories"} across ${multi.length} groups (kept the newest of each).\n` +
      `Check the removed texts - if any carries a fact the kept memory lacks, merge it in with memory_update:\n\n` +
      report.join("\n")
    );
  } catch (e: unknown) {
    return toolError("consolidate", "consolidate", e);
  }
}

// Clears every cache entry for the directory - relevance mode keys by
// directory + prompt hash, so a write invalidates them all.
function invalidateInjection(directory: string): void {
  for (const key of [...injectionCache.keys()]) {
    if (key === directory || key.startsWith(`${directory}\u0001`)) {
      injectionCache.delete(key);
    }
  }
}

// V2 entrypoint: registers the system-context injection hook and the agent tools
// through the plugin context. Directory comes from the plugin's load location
// (per-project instance, same semantics as V1's client.directory); sessionID
// comes from the tool execution context.
const ocpg = Plugin.define({
  id: "ocpg",
  async setup(ctx) {
    const directory = ctx.location.directory;
    retain();

    // Open the pool before the first turn needs it: Bun connects lazily, so
    // otherwise the TCP + SCRAM handshake is paid inside the first context hook.
    void sql`SELECT 1`.catch(() => {});

    // Warm the embedding model off the request path: a cold bge-m3 load is
    // ~2-3s (over the query budget), so without this the first hybrid query of
    // a session falls back to keyword-only. keep_alive pins it between requests.
    void embed(["ocpg session warmup"], EMBED_WRITE_TIMEOUT_MS);

    // Inject project memories into every model request's system context.
    // Relevance mode derives the retrieval query from the latest user message;
    // handleTransform owns the cache (32-slot, keyed by directory + prompt).
    await ctx.session.hook("context", async (event) => {
      const output: { system: string[] } = { system: [] };
      await handleTransform(output, directory, extractPromptQuery(event.messages));
      for (const text of output.system) event.system.push({ type: "text", text });
    });

    // Keyword capture (plan 1.1 revised): a trigger phrase ("remember this,
    // ...") stores the following text verbatim through the normal write path -
    // same validateWrite, same trigram dedup. No LLM call, and the prompt
    // itself is never mutated.
    await ctx.session.hook("prompt", (event) => {
      void captureFromPrompt(event.prompt.text, directory, event.sessionID);
    });

    // Agent tools: recall + remember with dedup-on-write. Input schemas are raw
    // JSON Schema (V2 contract); sizes are enforced in remember().
    await ctx.tool.transform((editor) => {
      editor.add({
        name: "memory_recall",
        // Direct (non-codemode) tool: memory ops are single-shot calls, not
        // scriptable sequences - hiding them behind the execute sandbox only
        // breaks direct invocation without adding value.
        options: { codemode: false },
        description:
          "Search past memories. Global types (preference, stack_fact) are always searched; this project's project_fact memories are searched by default. Use before non-trivial work to check for relevant lessons, fixes, and decisions.",
        input: {
          type: "object",
          properties: {
            query: { type: "string", description: "Search string (keyword + semantic paraphrase match); omit for the latest memories" },
            tags: {
              type: "array",
              items: { type: "string" },
              description:
                "Only return memories carrying all of these tags. Tags are not full-text " +
                "searchable (search covers content only), so this filter is the only way to reach them.",
            },
            global: {
              type: "boolean",
              description:
                "Also search other projects' project_fact memories (default: only this " +
                "project's project_fact memories, plus all preference/stack_fact memories, " +
                "which are always global).",
            },
            limit: { type: "number", description: "1-20, default 5" },
          },
          additionalProperties: false,
        },
        execute: async (input) => {
          return { content: await recall(input as RecallArgs, { directory }) };
        },
      });
      editor.add({
        name: "memory_remember",
        options: { codemode: false },
        // This description is the only place the write policy is guaranteed to
        // reach the model: it is in the tool schema every session, whereas the
        // injected block is skipped entirely for projects with no memories and
        // the user may have no project instructions at all.
        description:
          "Store a durable memory. preference and stack_fact are shared across all projects; " +
          "project_fact (the default) is visible only in this project unless recalled with " +
          "global: true. Use after user corrections (immediately), architecture decisions, " +
          "non-trivial fixes, environment facts, and stated preferences. " +
          "Do not store session progress, secrets, or anything the code itself already states.",
        input: {
          type: "object",
          properties: {
            content: {
              type: "string",
              description: `1-3 self-contained sentences capturing the why (${MIN_CONTENT}-${MAX_CONTENT} characters)`,
            },
            type: {
              type: "string",
              enum: [...MEMORY_TYPES],
              description:
                "preference = a standing user preference (global, injected first). " +
                "stack_fact = true about the tooling/stack itself, portable to any project " +
                "using the same stack (e.g. a Terraform module quirk, an ArgoCD gotcha, a " +
                "Helm chart convention) - global, like preference. " +
                "project_fact (default) = true about THIS specific project/customer only " +
                "(an environment quirk, a customer's specific request, a one-off workaround) " +
                "- visible only in this project unless the caller asks for global search. " +
                "Test: would this fact help in a different customer's repo using the same " +
                "tools? If yes, stack_fact. If no, project_fact.",
            },
            tags: {
              type: "array",
              items: { type: "string", maxLength: MAX_TAG_LENGTH },
              maxItems: MAX_TAGS,
              description:
                "Fine-grained facets: decision, debug, env, architecture, workaround, " +
                "language:<x>, framework:<x>, tool:<x>. The origin project is recorded " +
                "automatically (a project column, not a tag) - never add project:<name>.",
            },
          },
          required: ["content"],
          additionalProperties: false,
        },
        execute: async (input, tool) => {
          return { content: await remember(input as RememberArgs, { directory, sessionID: tool.sessionID }) };
        },
      });
      editor.add({
        name: "memory_forget",
        options: { codemode: false },
        description:
          "Delete a memory by id (get ids from memory_recall). Use for memories that are wrong or obsolete; prefer storing a corrected memory when the old one is still useful history. " +
          "preference and stack_fact can be deleted from any project; project_fact can only be " +
          "deleted by its origin project (the delete will fail with the owning project's name).",
        input: {
          type: "object",
          properties: {
            id: { type: "number", description: "The #id shown by memory_recall" },
          },
          required: ["id"],
          additionalProperties: false,
        },
        execute: async (input) => {
          return { content: await forget(input as ForgetArgs, { directory }) };
        },
      });
      editor.add({
        name: "memory_update",
        options: { codemode: false },
        description:
          "Rewrite an existing memory by id (get ids from memory_recall). Use when a memory is outdated but still worth keeping: the corrected content replaces the old, keeping the original learned date. " +
          "Omitted tags/type are kept as-is. preference and stack_fact can be edited from any " +
          "project; project_fact can only be edited by its origin project. " +
          "For obsolete memories use memory_forget; for genuinely new memories use memory_remember.",
        input: {
          type: "object",
          properties: {
            id: { type: "number", description: "The #id shown by memory_recall" },
            content: {
              type: "string",
              description: `1-3 self-contained sentences replacing the old content (${MIN_CONTENT}-${MAX_CONTENT} characters)`,
            },
            tags: {
              type: "array",
              items: { type: "string", maxLength: MAX_TAG_LENGTH },
              maxItems: MAX_TAGS,
              description: "Replaces the tag list; omit to keep the current tags",
            },
            type: {
              type: "string",
              enum: [...MEMORY_TYPES],
              description: "Replaces the memory type; omit to keep the current type",
            },
          },
          required: ["id", "content"],
          additionalProperties: false,
        },
        execute: async (input) => {
          return { content: await updateMemory(input as UpdateArgs, { directory }) };
        },
      });
      editor.add({
        name: "memory_consolidate",
        options: { codemode: false },
        // User-invoked cleanup, not a write-path gate: writes never reject on
        // duplicates, so call this when the corpus has accumulated near-dupes.
        // User-invoked cleanup, not a write-path gate: writes never reject on
        // duplicates, so call this when the corpus has accumulated near-dupes.
        // The deleted texts come back in the result so the calling agent can
        // merge unique facts into the survivors via memory_update.
        description:
          "Remove near-duplicate memories: keeps the newest of each >=80%-similar content group anywhere in the store and deletes the rest, returning the removed texts. " +
          "After running it, merge any unique fact from the removed texts into the kept memory via memory_update. Deterministic - run it when the user asks to tidy or consolidate memories.",
        input: {
          type: "object",
          properties: {},
          additionalProperties: false,
        },
        execute: async () => {
          return { content: await consolidate() };
        },
      });
    });

    // Close the SQL pool when the last plugin instance unloads.
    return dispose;
  },
});

const __internals = {
  get sql() {
    return sql;
  },
  truncateMemory,
  sanitizeMemory,
  withDeadline,
  formatBlock,
  handleTransform,
  recall,
  remember,
  forget,
  updateMemory,
  consolidate,
  extractMemoryRequest,  captureFromPrompt,
  invalidateInjection,
  resolveSslMode,
  resolveLimit,
  resolveMemoryType,
  validateWrite,
  logError,
  toolError,
  rateLimitOk,
  resetRateLimit,
  get injectionMode() {
    return injectionMode;
  },
  setInjectionMode(mode: "relevance" | "recency") {
    injectionMode = mode;
  },
  extractPromptQuery,
  hashQuery,
  orTsQuery,
  buildRecencyQuery,
  buildRelevanceQuery,
  buildVectorQuery,
  embed,
  embedAndStore,
  rrfMerge,
  hybridMerge,
  vectorLiteral,
  get ollamaBase() {
    return ollamaBase;
  },
  // Test hook: point the embed client at a dead endpoint to exercise the
  // keyword-only degradation paths (module state, like injectionMode).
  setOllamaBase(base: string) {
    ollamaBase = base;
  },
  retain,
  dispose,
};

// Attach test internals to the default export instead of as a named export
// (established contract; module exports stay limited to default).
export default Object.assign(ocpg, { __internals }) as typeof ocpg & {
  __internals: typeof __internals;
};
