// Benchmarks memory-retrieval strategies against the synthetic bench DBs.
//
// bun bench/run.ts [--sizes 500,5000] [--queries 150] [--skip-explain]
//
// Metrics per strategy x dataset:
//   latency    p50/p95 over the whole query mix (ms)
//   recall@5   share of the topic's relevant memories present in the top 5
//              (what injection actually serves - LIMIT 5)
//   mrr@5      1/rank of the first relevant memory
//   prec@5     share of the top 5 that is relevant (punishes noisy queries)
//   par. rec.  recall@5 on the paraphrase mix - synonyms that appear NOWHERE
//              in the corpus. The honest number for "would pgvector help?"
//   buffers    avg shared-buffer hit % (EXPLAIN sample; index vs seq scan)
//
// Ground truth: the generator gives every memory a topic and builds it from
// that topic's vocabulary, so a query built from a topic's words has a known
// relevant set: that topic's memories. Purely random data could measure only
// speed, never accuracy.
//
// "fts-or (prod)" runs the EXACT production query (imported from ocpg's
// __internals); the other strategies are candidates under evaluation. The
// EXPLAIN pass re-expresses each query as literal SQL for EXPLAIN (ANALYZE,
// BUFFERS) - parameters are pre-sanitized [a-z0-9 |] tokens, safe to inline.
import { SQL } from "bun";
import ocpg from "../ocpg.ts";
import { PROJECTS, benchDbName, makeSql, pick, rng } from "./config.ts";
import {
  type BenchRow,
  type Case,
  buildCorpusWords,
  buildMix,
  buildTopicIds,
  sanitizeAnd,
  sanitizeOr,
  score,
} from "./lib.ts";

const { __internals } = ocpg;

const args = process.argv.slice(2);
const opt = (name: string, fallback: string): string => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : fallback;
};
const sizes = opt("--sizes", "500,5000").split(",").map(Number);
const perMix = Number(opt("--queries", "150"));
const skipExplain = args.includes("--skip-explain");

type Strategy = {
  name: string;
  describe: string;
  run: (client: SQL, query: string, directory: string) => Promise<Array<{ content: string; project: string }>>;
  explainSql: (query: string, directory: string) => string;
};

const strategies: Strategy[] = [
  {
    name: "fts-or (prod)",
    describe: "OR to_tsquery + ts_rank + same-project boost - what ocpg ships",
    run: (c, q, d) => __internals.buildRelevanceQuery(c, sanitizeOr(q), d) as unknown as Promise<Array<{ content: string; project: string }>>,
    explainSql: (q, d) =>
      `SELECT id, content, project FROM memories WHERE search_vector @@ to_tsquery('english', '${sanitizeOr(q)}') ORDER BY ts_rank(search_vector, to_tsquery('english', '${sanitizeOr(q)}')) + (CASE WHEN project = '${d}' THEN 0.01 ELSE 0 END) DESC, created_at DESC LIMIT 5`,
  },
  {
    name: "fts-and",
    describe: "websearch_to_tsquery AND semantics - the rejected alternative to prod's OR shape",
    run: async (c, q, d) =>
      (await c`SELECT content, project FROM memories WHERE search_vector @@ websearch_to_tsquery('english', ${q}) AND (memory_type != 'project_fact' OR project = ${d}) ORDER BY ts_rank(search_vector, websearch_to_tsquery('english', ${q})) DESC LIMIT 5`) as Array<{ content: string; project: string }>,
    explainSql: (q, d) =>
      `SELECT id, content, project FROM memories WHERE search_vector @@ websearch_to_tsquery('english', '${sanitizeAnd(q)}') AND (memory_type != 'project_fact' OR project = '${d}') ORDER BY ts_rank(search_vector, websearch_to_tsquery('english', '${sanitizeAnd(q)}')) DESC LIMIT 5`,
  },
  {
    name: "fts-or-cd",
    describe: "OR to_tsquery + ts_rank_cd (coverage-weighted ranker)",
    run: async (c, q, d) =>
      (await c`SELECT content, project FROM memories WHERE search_vector @@ to_tsquery('english', ${sanitizeOr(q)}) AND (memory_type != 'project_fact' OR project = ${d}) ORDER BY ts_rank_cd(search_vector, to_tsquery('english', ${sanitizeOr(q)})) + (CASE WHEN project = ${d} THEN 0.01 ELSE 0 END) DESC LIMIT 5`) as Array<{ content: string; project: string }>,
    explainSql: (q, d) =>
      `SELECT id, content, project FROM memories WHERE search_vector @@ to_tsquery('english', '${sanitizeOr(q)}') AND (memory_type != 'project_fact' OR project = '${d}') ORDER BY ts_rank_cd(search_vector, to_tsquery('english', '${sanitizeOr(q)}')) + (CASE WHEN project = '${d}' THEN 0.01 ELSE 0 END) DESC LIMIT 5`,
  },
  {
    name: "trgm-blend",
    describe: "fts-or rank + pg_trgm similarity (catches typos/substrings, costs a scan)",
    run: async (c, q, d) =>
      (await c`SELECT content, project FROM memories WHERE (search_vector @@ to_tsquery('english', ${sanitizeOr(q)}) OR similarity(content, ${q}) >= 0.2) AND (memory_type != 'project_fact' OR project = ${d}) ORDER BY ts_rank(search_vector, to_tsquery('english', ${sanitizeOr(q)})) + similarity(content, ${q}) * 0.3 + (CASE WHEN project = ${d} THEN 0.01 ELSE 0 END) DESC LIMIT 5`) as Array<{ content: string; project: string }>,
    explainSql: (q, d) =>
      `SELECT id, content, project FROM memories WHERE (search_vector @@ to_tsquery('english', '${sanitizeOr(q)}') OR similarity(content, '${q.replace(/'/g, "''")}') >= 0.2) AND (memory_type != 'project_fact' OR project = '${d}') ORDER BY ts_rank(search_vector, to_tsquery('english', '${sanitizeOr(q)}')) + similarity(content, '${q.replace(/'/g, "''")}') * 0.3 + (CASE WHEN project = '${d}' THEN 0.01 ELSE 0 END) DESC LIMIT 5`,
  },
  {
    name: "fts-or-recency",
    describe: "fts-or rank blended with a small recency-decay prior",
    run: async (c, q, d) =>
      (await c`SELECT content, project FROM memories WHERE search_vector @@ to_tsquery('english', ${sanitizeOr(q)}) AND (memory_type != 'project_fact' OR project = ${d}) ORDER BY ts_rank(search_vector, to_tsquery('english', ${sanitizeOr(q)})) + 0.05 / (extract(epoch from (now() - created_at)) / 86400 + 2) + (CASE WHEN project = ${d} THEN 0.01 ELSE 0 END) DESC LIMIT 5`) as Array<{ content: string; project: string }>,
    explainSql: (q, d) =>
      `SELECT id, content, project FROM memories WHERE search_vector @@ to_tsquery('english', '${sanitizeOr(q)}') AND (memory_type != 'project_fact' OR project = '${d}') ORDER BY ts_rank(search_vector, to_tsquery('english', '${sanitizeOr(q)}')) + 0.05 / (extract(epoch from (now() - created_at)) / 86400 + 2) + (CASE WHEN project = '${d}' THEN 0.01 ELSE 0 END) DESC LIMIT 5`,
  },
  {
    name: "recency-only",
    describe: "the old blind last-5 (baseline; ignores the query)",
    run: (c, _q, d) => __internals.buildRecencyQuery(c, d) as unknown as Promise<Array<{ content: string; project: string }>>,
    explainSql: (_q, d) =>
      `SELECT id, content, project FROM memories WHERE (memory_type != 'project_fact' OR project = '${d}') ORDER BY created_at DESC LIMIT 5`,
  },
];

async function loadRows(db: SQL): Promise<BenchRow[]> {
  return (await db`SELECT id, content, project FROM memories`) as BenchRow[];
}

async function benchDataset(size: number): Promise<void> {
  const db = new SQL(makeSql(benchDbName(size)));
  try {
    const rows = await loadRows(db);
    console.log(`\n=== ${benchDbName(size)}: ${rows.length} memories, ${new Set(rows.map((r) => r.project)).size} projects ===`);
    const mix = buildMix(rng(999 + size), buildCorpusWords(rows), perMix);
    const columnHeads = `strategy          p50ms  p95ms  recall@5  mrr@5  prec@5  para-rec  bufhit`;
    console.log(columnHeads);

    for (const strategy of strategies) {
      const rand = rng(size * 31 + 7);
      const project = pick(rand, PROJECTS);
      const topicIds = buildTopicIds(rows, project);
      const latencies: number[] = [];
      const scores: Array<{ s: NonNullable<ReturnType<typeof score>>; kind: Case["kind"] }> = [];

      for (const c of mix) {
        const t0 = performance.now();
        const returned = await strategy.run(db, c.text, project);
        latencies.push(performance.now() - t0);
        const s = score(returned, topicIds.get(c.topicIdx) ?? new Set());
        if (s) scores.push({ s, kind: c.kind });
      }

      latencies.sort((a, b) => a - b);
      const p = (q: number): number => latencies[Math.min(latencies.length - 1, Math.floor((q / 100) * latencies.length))];
      const avg = (xs: number[]): number => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0);
      const direct = scores.filter((x) => x.kind === "direct");
      const para = scores.filter((x) => x.kind === "paraphrase");

      let bufhit = NaN;
      if (!skipExplain) {
        let hits = 0, total = 0;
        for (let i = 0; i < 10 && i < mix.length; i += 2) {
          const c = mix[Math.floor(rand() * mix.length)];
          try {
            const plan = await db.unsafe(`EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) ${strategy.explainSql(c.text, project)}`);
            const root = ((plan as Array<{ "QUERY PLAN": Array<Record<string, unknown>> }>)[0]["QUERY PLAN"])[0];
            const walk = (node: unknown, depth: number): void => {
              if (depth > 4 || typeof node !== "object" || node === null) return;
              if (Array.isArray(node)) {
                for (const child of node) walk(child, depth + 1);
                return;
              }
              for (const [k, v] of Object.entries(node)) {
                if (k === "Shared Hit Blocks") hits += Number(v);
                if (k === "Shared Read Blocks") total += Number(v);
                walk(v, depth + 1);
              }
            };
            walk(root, 0);
          } catch {
            // EXPLAIN text drift on a candidate must not break the run.
          }
        }
        if (total + hits > 0) bufhit = hits / (hits + total);
      }

      const row = [
        strategy.name.padEnd(16),
        p(50).toFixed(2).padStart(5),
        p(95).toFixed(2).padStart(6),
        avg(direct.concat(para).map((x) => x.s.recall)).toFixed(3).padStart(8),
        avg(direct.concat(para).map((x) => x.s.mrr)).toFixed(3).padStart(6),
        avg(direct.concat(para).map((x) => x.s.prec)).toFixed(3).padStart(7),
        avg(para.map((x) => x.s.recall)).toFixed(3).padStart(8),
        Number.isNaN(bufhit) ? "     -" : `${(bufhit * 100).toFixed(0)}%`.padStart(6),
      ].join(" ");
      console.log(`${row}   (n=${scores.length})`);
    }
    console.log(strategies.map((s) => `${s.name.padEnd(16)} ${s.describe}`).join("\n"));
  } finally {
    await db.close({ timeout: 0 });
  }
}

for (const size of sizes) {
  await benchDataset(size);
}
