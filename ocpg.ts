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
type RecallArgs = { query?: string; global?: boolean; limit?: number; tags?: string[]; scope?: "project" | "user" };
type RememberArgs = {
  content: string;
  tags?: string[];
  force?: boolean;
  scope?: "project" | "user";
  type?: MemoryType;
};
type ForgetArgs = { id: number };

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

// --- User scope (plan 1.2, revised: sentinel value, no migration) ---

// User memories are ordinary rows with the sentinel project value `user:<id>`,
// written into the existing project column - identical semantics to a scope
// column with zero migration. OCPG_USER_ID is read once at init (env-only, no
// process spawning); unset means user scope is disabled entirely and every
// query degrades to exactly the pre-feature behavior.
//
// Mutable module state + a reset hook so tests can toggle it deterministically.
let userScope = resolveUserScope(process.env.OCPG_USER_ID);

function resolveUserScope(raw: string | undefined): string | null {
  const id = raw?.trim();
  return id ? `user:${id}` : null;
}

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

// The injection query selects neither id nor project - they are never rendered.
type InjectionRow = Pick<MemoryRow, "content" | "tags" | "date">;

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

// --- Injection pipeline ---

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
    lines.push(`- [${row.date}]${tagStr} ${sanitizeMemory(truncateMemory(row.content))}`);
  }
  lines.push("");
  lines.push(
    "Before non-trivial work, check these. After user corrections, architecture decisions, or non-trivial fixes, call memory_remember. Use memory_recall to search past lessons.",
  );
  lines.push("</persistent-project-memory>");
  return lines.join("\n");
}

// Keyed by project directory, not session: the query depends only on the
// directory, so every session in a project shares one entry and a remember in
// any session invalidates it for all of them. An empty string is cached for
// projects with no memories so they stop re-querying, and nothing is injected.
const injectionCache = new Map<string, string>();

// Session-independent by design: the block depends only on the project
// directory, so the hook passes nothing else.
async function handleTransform(
  output: { system: string[] },
  directory: string,
): Promise<void> {
  if (!directory) return;
  const cached = injectionCache.get(directory);
  if (cached !== undefined) {
    if (cached) output.system.push(cached);
    return;
  }
  try {
    // Injection stays keyed by the directory alone: when user scope is enabled
    // the block additionally includes the shared user rows, but that still
    // depends only on the directory (the user scope is process-wide env config).
    const projectCond = userScope
      ? sql`WHERE (project = ${directory} OR project = ${userScope})`
      : sql`WHERE project = ${directory}`;
    const rows = await withDeadline(
      sql`
      SELECT content, coalesce(tags, '{}') AS tags,
             to_char(created_at, 'YYYY-MM-DD') AS date
      FROM memories
      ${projectCond}
      ORDER BY (memory_type = 'preference') DESC, created_at DESC
      LIMIT 5
    ` as unknown as PromiseLike<InjectionRow[]>,
      1000,
    );
    const block = formatBlock(rows, directory);
    // Evict oldest entry when cache exceeds 32
    if (injectionCache.size >= 32) {
      const firstKey = injectionCache.keys().next().value;
      if (firstKey !== undefined) injectionCache.delete(firstKey);
    }
    injectionCache.set(directory, block);
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
// type is always defaulted. episodic is reserved for the (cut, opt-in) 1.3
// feature; remember accepts it so the vocabulary stays in one place.
const MEMORY_TYPES = ["preference", "project_fact", "episodic"] as const;
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
    // scope: "user" addresses the shared user scope; global: true already
    // covers user rows since it drops the project filter entirely.
    if (args.scope === "user" && !userScope) {
      return "ERROR: user scope is disabled (set OCPG_USER_ID to enable it).";
    }
    const projectCond = args.global
      ? sql``
      : args.scope === "user"
        ? sql`AND project = ${userScope}`
        : sql`AND project = ${ctx.directory}`;
    const queryCond = args.query
      ? sql`AND search_vector @@ websearch_to_tsquery('english', ${args.query})`
      : sql``;
    // Tags are not part of search_vector (it covers content only), so they are
    // unreachable by query alone. Matches rows carrying ALL the given tags,
    // served by idx_memories_tags.
    const tagList = Array.isArray(args.tags) ? args.tags.filter((t) => typeof t === "string" && t) : [];
    const tagCond = tagList.length
      ? sql`AND tags @> ${sql.array(tagList, "text")}`
      : sql``;
    // Relevance-ranked when searching; recency-ordered for a plain project browse.
    const orderBy = args.query
      ? sql`ORDER BY ts_rank(search_vector, websearch_to_tsquery('english', ${args.query})) DESC`
      : sql`ORDER BY created_at DESC`;

    const rows = await sql`
      SELECT id, content, coalesce(tags, '{}') AS tags,
             to_char(created_at, 'YYYY-MM-DD') AS date,
             project, memory_type
      FROM memories
      WHERE 1=1 ${projectCond} ${queryCond} ${tagCond}
      ${orderBy}
      LIMIT ${limit}
    ` as (MemoryRow & { memory_type: string })[];

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

// Trigram similarity threshold for dedup-on-write. Measured on a real
// 485-memory corpus: the previous rule (FTS on the first 60 characters) let 28
// pairs at >=0.8 similarity through because they differed in their opening
// words, while wrongly rejecting ~1% of genuinely distinct memories. 0.8 is
// strict enough that only restatements collide.
const DEDUP_SIMILARITY = 0.8;

async function remember(
  args: RememberArgs,
  ctx: { directory: string; sessionID: string },
): Promise<string> {
  try {
    const invalid = validateWrite(args);
    if (invalid) return invalid;

    // Tags are stored verbatim - project scoping lives in the project column, not tags.
    const tags = args.tags ?? [];
    const scope = args.scope === "user" ? "user" : "project";
    if (scope === "user" && !userScope) {
      return "ERROR: user scope is disabled (set OCPG_USER_ID to enable it).";
    }
    // The write target: the calling project's directory, or the shared user
    // sentinel. Dedup is scoped to the target so a user write never collides
    // with a project row (or vice versa).
    const target = scope === "user" ? (userScope as string) : ctx.directory;
    const basename = ctx.directory.split('/').pop() ?? ctx.directory;

    if (!args.force) {
      // Dedup: target-scoped trigram similarity over the whole content. No
      // trigram index - the project filter narrows to a few hundred rows, which
      // similarity() scans in single-digit milliseconds.
      const dedup = await sql`
        SELECT id, round(similarity(content, ${args.content})::numeric, 2) AS score
        FROM memories
        WHERE project = ${target}
          AND (content = ${args.content} OR similarity(content, ${args.content}) >= ${DEDUP_SIMILARITY})
        ORDER BY similarity(content, ${args.content}) DESC
        LIMIT 1
      ` as { id: number; score: string }[];

      if (dedup.length > 0) {
        const where = scope === "user" ? " in user scope" : "";
        return `Similar memory already stored as #${dedup[0].id} (similarity ${dedup[0].score})${where}; skipping insert. Pass force: true to store it anyway.`;
      }
    }

    // sql.array(tags) alone encodes text[] with quoted elements under bun 1.4.2;
    // the element type hint is required for clean array storage.
    const inserted = await sql`
      INSERT INTO memories (content, tags, session_id, project, memory_type)
      VALUES (${args.content}, ${sql.array(tags, "text")}, ${ctx.sessionID}, ${target}, ${resolveMemoryType(args.type)})
      RETURNING id
    ` as { id: number }[];

    // The injection cache is keyed by directory and user rows are injected into
    // it, so a user-scope write invalidates the calling project's entry too.
    invalidateInjection(ctx.directory);
    return scope === "user"
      ? `Stored memory #${inserted[0].id} for user scope (shared across projects).`
      : `Stored memory #${inserted[0].id} for project ${basename}.`;
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

// Project-scoped by construction: an agent can only delete what its own project
// can recall, so a poisoned id from another project silently matches nothing.
// When user scope is enabled the boundary deliberately widens to include the
// shared user sentinel - user memories are visible to every project of the
// user, so any of them can delete them. Documented in the tool description.
async function forget(
  args: ForgetArgs,
  ctx: { directory: string },
): Promise<string> {
  try {
    const id = Number(args.id);
    if (!Number.isInteger(id) || id <= 0) {
      return "ERROR: id must be a positive integer (the #id shown by memory_recall).";
    }
    const projectCond = userScope
      ? sql`project IN (${ctx.directory}, ${userScope})`
      : sql`project = ${ctx.directory}`;
    const deleted = await sql`
      DELETE FROM memories
      WHERE id = ${id} AND ${projectCond}
      RETURNING id
    ` as { id: number }[];

    if (deleted.length === 0) {
      return `No memory #${id} in this project; nothing deleted.`;
    }
    invalidateInjection(ctx.directory);
    return `Deleted memory #${id}.`;
  } catch (e: unknown) {
    return toolError("forget", "forget", e);
  }
}

function invalidateInjection(directory: string): void {
  injectionCache.delete(directory);
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

    // Inject project memories into every model request's system context.
    // handleTransform owns the per-directory cache (32-slot, invalidated on remember).
    await ctx.session.hook("context", async (event) => {
      const output: { system: string[] } = { system: [] };
      await handleTransform(output, directory);
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
          "Search past memories stored for this project. Use before non-trivial work to check for relevant lessons, fixes, and decisions.",
        input: {
          type: "object",
          properties: {
            query: { type: "string", description: "Full-text search string; omit for the latest memories" },
            tags: {
              type: "array",
              items: { type: "string" },
              description:
                "Only return memories carrying all of these tags. Tags are not full-text " +
                "searchable (search covers content only), so this filter is the only way to reach them.",
            },
            global: { type: "boolean", description: "Search across all projects (default: current project only)" },
            scope: {
              type: "string",
              enum: ["project", "user"],
              description: '"user" searches your shared cross-project memories instead of this project\'s (requires user scope to be enabled)',
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
          "Store a durable memory for this project. Use after user corrections (immediately), " +
          "architecture decisions, non-trivial fixes, environment facts, and stated preferences. " +
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
                "preference = a standing user preference (these are injected first); " +
                "project_fact (default) = decisions, fixes, env facts. Omit unless the memory is a preference.",
            },
            tags: {
              type: "array",
              items: { type: "string", maxLength: MAX_TAG_LENGTH },
              maxItems: MAX_TAGS,
              description:
                "Fine-grained facets: decision, debug, env, architecture, workaround, " +
                "language:<x>, framework:<x>, tool:<x>. Project scoping is automatic (a project " +
                "column, not a tag) - never add project:<name>.",
            },
            force: {
              type: "boolean",
              description:
                "Store even if a similar memory exists (use only after a dedup rejection you judge to be wrong)",
            },
            scope: {
              type: "string",
              enum: ["project", "user"],
              description:
                '"user" stores for you across all projects (requires user scope to be enabled); default "project" stores for this project only',
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
          "Deletes match this project's memories and, when user scope is enabled, your shared user memories too - those are visible to all your projects by design, so any of them can delete them.",
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
  extractMemoryRequest,
  captureFromPrompt,
  invalidateInjection,
  resolveSslMode,
  resolveLimit,
  resolveMemoryType,
  validateWrite,
  logError,
  resolveUserScope,
  toolError,
  rateLimitOk,
  resetRateLimit,
  get userScope() {
    return userScope;
  },
  setUserScope(raw: string | undefined | null) {
    userScope = resolveUserScope(raw ?? undefined);
  },
  retain,
  dispose,
};

// Attach test internals to the default export instead of as a named export
// (established contract; module exports stay limited to default).
export default Object.assign(ocpg, { __internals }) as typeof ocpg & {
  __internals: typeof __internals;
};
