// ocpg - DB access layer for OpenCode persistent memory plugin.
import { SQL } from "bun";
import { Plugin } from "@opencode/plugin";

// --- DB config: plugin options > env > defaults. Password is deliberately env-only (never in config).
type DbOptions = {
  host?: string;
  port?: number;
  user?: string;
  database?: string;
};
type DbConfig = Required<DbOptions>;
type RecallArgs = { query?: string; global?: boolean; limit?: number };
type RememberArgs = { content: string; tags?: string[] };

// Defaults resolved ONCE at module init — the pass lookup here is the only permitted spawn in this file.
const defaultConfig: DbConfig = {
  host: process.env.OCPG_HOST || "localhost",
  port: Number(process.env.OCPG_PORT) || 5432,
  user: process.env.OCPG_USER || "pguser",
  database: process.env.OCPG_DB || "agent-memory",
};
const password =
  process.env.OCPG_PASSWORD ||
  Bun.spawnSync(["pass", "show", "postgres-workstation-password"])
    .stdout.toString()
    .trim();

// Options-object constructor, not a URL string: Bun's SQL parses string URLs via
// url.parse(), which emits the DEP0169 DeprecationWarning at plugin load under opencode.
function makeSql(cfg: DbConfig): SQL {
  return new SQL({
    hostname: cfg.host,
    port: cfg.port,
    username: cfg.user,
    password,
    database: cfg.database,
    max: 2,
  });
}

let sql = makeSql(defaultConfig);

// Swap the pool when the plugin loads with config options ({ "package": "@dzhi/ocpg", "options": {...} } in opencode.jsonc).
// No-op without options so the module-level env/default config stands. Pools are lazy — a never-connected pool closes cleanly.
function reconfigure(options?: DbOptions): void {
  if (!options) return;
  void sql.close().catch(() => {});
  sql = makeSql({ ...defaultConfig, ...options });
}

export interface MemoryRow {
  id: number;
  content: string;
  tags: string[] | null;
  project: string;
  date: string;
}

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
function logError(message: string): void {
  if (!rateLimitOk("db-error")) return;
  console.error(`[ocpg] ${message}`);
}

// --- Injection pipeline ---

function truncateMemory(content: string): string {
  if (content.length <= 600) return content;
  return content.slice(0, 600) + "…[truncated]";
}

function formatBlock(rows: MemoryRow[], projectDir: string): string {
  const lines: string[] = [
    "<persistent-project-memory>",
    `Project: ${projectDir}`,
    "Memories:",
  ];
  for (const row of rows) {
    const tags = row.tags ?? [];
    const tagStr = tags.length ? ` [${tags.join(", ")}]` : "";
    lines.push(`- [${row.date}]${tagStr} ${truncateMemory(row.content)}`);
  }
  lines.push("");
  lines.push(
    "Before non-trivial work, check these. After user corrections, architecture decisions, or non-trivial fixes, call memory_remember. Use memory_recall to search past lessons.",
  );
  lines.push("</persistent-project-memory>");
  return lines.join("\n");
}

const injectionCache = new Map<string, string>();

async function handleTransform(
  input: { sessionID?: string; model?: unknown },
  output: { system: string[] },
  directory: string,
): Promise<void> {
  if (!input.sessionID) return;
  const sid = input.sessionID;
  const cached = injectionCache.get(sid);
  if (cached !== undefined) {
    output.system.push(cached);
    return;
  }
  try {
    const rows = await sql`
      SELECT content, coalesce(tags, '{}') AS tags,
             to_char(created_at, 'YYYY-MM-DD') AS date
      FROM memories
      WHERE project = ${directory}
      ORDER BY created_at DESC
      LIMIT 5
    ` as MemoryRow[];
    const block = formatBlock(rows, directory);
    // Evict oldest entry when cache exceeds 32
    if (injectionCache.size >= 32) {
      const firstKey = injectionCache.keys().next().value!;
      injectionCache.delete(firstKey);
    }
    injectionCache.set(sid, block);
    output.system.push(block);
  } catch (e: unknown) {
    logError(`ocpg injection failed: ${e instanceof Error ? e.message : String(e)}`);
  }
}

// --- Dispose ---

async function dispose(): Promise<void> {
  await sql.close().catch(() => {});
}

// --- Agent tools: recall + remember with dedup-on-write ---

function normalizeTags(tags: string[] | undefined, projectDir: string): string[] {
  const input = tags ?? [];
  const base = projectDir.split('/').pop() ?? projectDir;
  return [...input, `project:${base}`];
}

async function recall(
  args: RecallArgs,
  ctx: { directory: string },
): Promise<string> {
  try {
    const limit = Math.min(Math.max(args.limit ?? 5, 1), 20);
    const projectCond = args.global
      ? sql``
      : sql`AND project = ${ctx.directory}`;
    const queryCond = args.query
      ? sql`AND search_vector @@ websearch_to_tsquery('english', ${args.query})`
      : sql``;
    // Relevance-ranked when searching; recency-ordered for a plain project browse.
    const orderBy = args.query
      ? sql`ORDER BY ts_rank(search_vector, websearch_to_tsquery('english', ${args.query})) DESC`
      : sql`ORDER BY created_at DESC`;

    const rows = await sql`
      SELECT id, content, coalesce(tags, '{}') AS tags,
             to_char(created_at, 'YYYY-MM-DD') AS date,
             project
      FROM memories
      WHERE 1=1 ${projectCond} ${queryCond}
      ${orderBy}
      LIMIT ${limit}
    ` as MemoryRow[];

    if (rows.length === 0) return "No memories found.";

    return rows
      .map((r) => {
        const tags = r.tags ?? [];
        const tagStr = tags.length ? ` (${tags.join(', ')})` : '';
        return `[${r.date}] [${r.project}]${tagStr}\n#${r.id}\n${r.content}`;
      })
      .join('\n---\n');
  } catch (e: unknown) {
    logError(`ocpg recall failed: ${e instanceof Error ? e.message : String(e)}`);
    return `ERROR: ${e instanceof Error ? e.message : String(e)}`;
  }
}

async function remember(
  args: RememberArgs,
  ctx: { directory: string; sessionID: string },
): Promise<string> {
  try {
    if (args.content.length < 10) {
      return 'ERROR: content must be at least 10 characters.';
    }

    const normalizedTags = normalizeTags(args.tags, ctx.directory);
    const basename = ctx.directory.split('/').pop() ?? ctx.directory;

    // Dedup: project-scoped, common-opening-words AND-match via FTS
    const dedup = await sql`
      SELECT id FROM memories
      WHERE project = ${ctx.directory}
        AND (
          content = ${args.content}
          OR search_vector @@ plainto_tsquery('english', ${args.content.slice(0, 60)})
        )
      ORDER BY created_at DESC
      LIMIT 1
    ` as { id: number }[];

    if (dedup.length > 0) {
      // ponytail: dedup uses common-opening-words AND-match across rows via FTS
      // so false positives are expected; upgrade path = pg_trgm similarity or
      // wider dedup scope.
      return `Similar memory already stored as #${dedup[0].id} for this project; skipping insert.`;
    }

    const inserted = await sql`
      INSERT INTO memories (content, tags, session_id, project)
      VALUES (${args.content}, ${sql.array(normalizedTags)}, ${ctx.sessionID}, ${ctx.directory})
      RETURNING id
    ` as { id: number }[];

    invalidateInjection(ctx.sessionID);
    return `Stored memory #${inserted[0].id} for project ${basename}.`;
  } catch (e: unknown) {
    logError(`ocpg remember failed: ${e instanceof Error ? e.message : String(e)}`);
    return `ERROR: ${e instanceof Error ? e.message : String(e)}`;
  }
}

function invalidateInjection(sessionID: string): void {
  injectionCache.delete(sessionID);
}

// V2 entrypoint: registers the system-context injection hook and the agent tools
// through the plugin context. Directory comes from the plugin's load location
// (per-project instance, same semantics as V1's client.directory); sessionID
// comes from the tool execution context.
const ocpg = Plugin.define({
  id: "ocpg",
  async setup(ctx) {
    reconfigure(ctx.options as DbOptions | undefined);
    const directory = ctx.location.directory;

    // Inject project memories into every model request's system context.
    // handleTransform owns the per-session cache (32-slot, invalidated on remember).
    await ctx.session.hook("context", async (event) => {
      const output: { system: string[] } = { system: [] };
      await handleTransform({ sessionID: event.sessionID, model: event.model }, output, directory);
      for (const text of output.system) event.system.push({ type: "text", text });
    });

    // Agent tools: recall + remember with dedup-on-write. Input schemas are raw
    // JSON Schema (V2 contract); content length is enforced in remember().
    await ctx.tool.transform((editor) => {
      editor.add({
        name: "memory_recall",
        description:
          "Search past memories stored for this project. Use before non-trivial work to check for relevant lessons, fixes, and decisions.",
        input: {
          type: "object",
          properties: {
            query: { type: "string", description: "Full-text search string; omit for the latest memories" },
            global: { type: "boolean", description: "Search across all projects (default: current project only)" },
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
        description:
          "Store a memory for this project. Use after user corrections, architecture decisions, or non-trivial fixes.",
        input: {
          type: "object",
          properties: {
            content: { type: "string", description: "1-3 self-contained sentences capturing the why" },
            tags: {
              type: "array",
              items: { type: "string" },
              description:
                "Category prefixes: preference, decision, debug, env, architecture, workaround, language:<x>, framework:<x>, tool:<x>",
            },
          },
          required: ["content"],
          additionalProperties: false,
        },
        execute: async (input, tool) => {
          return { content: await remember(input as RememberArgs, { directory, sessionID: tool.sessionID }) };
        },
      });
    });

    // Close the SQL pool when the plugin unloads.
    return dispose;
  },
});

const __internals = {
  get sql() {
    return sql;
  },
  reconfigure,
  truncateMemory,
  formatBlock,
  handleTransform,
  normalizeTags,
  recall,
  remember,
  invalidateInjection,
  logError,
  rateLimitOk,
  resetRateLimit,
  dispose,
};

// Attach test internals to the default export instead of as a named export
// (established contract; module exports stay limited to default).
export default Object.assign(ocpg, { __internals }) as typeof ocpg & {
  __internals: typeof __internals;
};
