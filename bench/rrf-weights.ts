// RRF weight sweep for the hybrid merge: does weighting the embedding half
// recover the real-corpus paraphrase hits that equal-weight RRF dilutes
// (bench/report.ts finding), without costing synthetic direct-query recall?
//
// Candidate lists are weight-independent (same keyword query, same vector
// query), so they are fetched ONCE per query and merged per weight - the
// sweep costs one query pass, not four.
//
//   bun bench/rrf-weights.ts [--weights 1,1.5,2,3] [--queries 150]
import { SQL } from "bun";
import ocpg from "../ocpg.ts";
import { PROJECTS, pick, rng } from "./config.ts";
import { type BenchRow, type Case, buildCorpusWords, buildMix, buildTopicIds, sanitizeOr, score } from "./lib.ts";
import { PAIRS } from "./paraphrase-pairs.ts";

const { __internals } = ocpg;

const args = process.argv.slice(2);
const opt = (name: string, fallback: string): string => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : fallback;
};
const ollama = opt("--ollama", "http://localhost:11434");
const weights = opt("--weights", "1,1.5,2,3").split(",").map(Number);
const perMix = Number(opt("--queries", "150"));
const BENCH = { host: "localhost", port: 5433, user: "ocpguser", password: "bench", db: "agent-memory-bench-50000" };
const BENCH_COL = "embedding_bge_m3";

async function embed(texts: string[]): Promise<number[][]> {
  const res = await fetch(`${ollama}/api/embed`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ model: "bge-m3", input: texts, keep_alive: "30m" }),
  });
  if (!res.ok) throw new Error(`ollama /api/embed: HTTP ${res.status}`);
  return ((await res.json()) as { embeddings: number[][] }).embeddings;
}

// rrfMerge with a per-list weight: score = sum(weight / (60 + rank)).
// weight 1 == production's equal-weight merge.
function wrrf<T extends { content: string }>(lists: T[][], listWeights: number[], k = 60): T[] {
  const scores = new Map<string, { score: number; row: T }>();
  lists.forEach((list, li) => {
    const w = listWeights[li] ?? 1;
    list.forEach((row, i) => {
      const e = scores.get(row.content) ?? { score: 0, row };
      e.score += w / (k + i + 1);
      scores.set(row.content, e);
    });
  });
  return [...scores.values()].sort((a, b) => b.score - a.score).map((e) => e.row);
}

const pct = (sorted: number[], q: number) => sorted[Math.min(sorted.length - 1, Math.floor((q / 100) * sorted.length))];

type Row = { w: number; real: string; synRecall: string; synDirect: string; synPara: string; p50: string; p95: string };
const table: Row[] = [];

// ------------------------------------------------------------- real side
{
  const db = new SQL({
    hostname: process.env.OCPG_HOST || "localhost",
    port: Number(process.env.OCPG_PORT) || 5432,
    username: process.env.OCPG_USER || "ocpguser",
    password: process.env.OCPG_PASSWORD || "",
    database: process.env.OCPG_DB || "ocpg",
    ssl: "disable",
    max: 2,
  });
  try {
    // Fetch both candidate lists once per pair.
    const fetched: Array<{ kw: Array<{ content: string }>; em: Array<{ content: string }>; content: string }> = [];
    let kwOnly = 0, emOnly = 0;
    const squash = (s: string) => s.replace(/\s+/g, " ");
    for (const [idStr, pair] of Object.entries(PAIRS)) {
      const found = (await db`SELECT project, content FROM memories WHERE id = ${Number(idStr)}`) as {
        project: string;
        content: string;
      }[];
      if (found.length === 0 || squash(found[0].content) !== squash(pair.content)) continue;
      const { project, content } = found[0];
      const kw = (await __internals.buildRelevanceQuery(db, __internals.orTsQuery(pair.q), project)) as unknown as Array<{
        content: string;
      }>;
      const [v] = await embed([pair.q]);
      const em = (await __internals.buildVectorQuery(db, __internals.vectorLiteral(v), project)) as unknown as Array<{
        content: string;
      }>;
      if (kw.slice(0, 5).some((r) => r.content === content)) kwOnly++;
      if (em.slice(0, 5).some((r) => r.content === content)) emOnly++;
      fetched.push({ kw, em, content });
    }
    console.log(`\n=== real corpus paraphrase hit@5 (n=${fetched.length}) ===`);
    console.log(`anchors: keyword-only ${kwOnly}/${fetched.length} | embedding-only ${emOnly}/${fetched.length}`);
    for (const w of weights) {
      const hits = fetched.filter(({ kw, em, content }) =>
        wrrf([kw, em], [1, w]).slice(0, 5).some((r) => r.content === content),
      ).length;
      const row = table.find((r) => r.w === w) ?? ({ w } as Row);
      row.real = `${hits}/${fetched.length}`;
      table.push(row);
      console.log(`weight ${w}x: ${hits}/${fetched.length}`);
    }
  } finally {
    await db.close({ timeout: 0 });
  }
}

// ------------------------------------------------------------ bench side
{
  const db = new SQL({
    hostname: BENCH.host,
    port: BENCH.port,
    username: BENCH.user,
    password: BENCH.password,
    database: BENCH.db,
    ssl: "disable",
    max: 4,
  });
  try {
    const rows = (await db`SELECT id, content, project FROM memories`) as BenchRow[];
    const size = 50000;
    const mix = buildMix(rng(999 + size), buildCorpusWords(rows), perMix);
    const project = pick(rng(size * 31 + 7), PROJECTS);
    const topicIds = buildTopicIds(rows, project);
    const queryCache = new Map<string, string>();
    console.log(`\n=== ${BENCH.db}: ${rows.length} memories, ${mix.length} queries ===`);

    // One pass: fetch both lists per query, then merge per weight. Latency is
    // weight-independent (same queries; only the merge differs) - measured here.
    const latencies: number[] = [];
    type PerWeight = Array<{ s: NonNullable<ReturnType<typeof score>>; kind: Case["kind"] }>;
    const perWeight = new Map<number, PerWeight>(weights.map((w) => [w, []]));
    const anchors: Record<string, PerWeight> = { keyword: [], embed: [] };
    for (const c of mix) {
      const t0 = performance.now();
      const kw = (await __internals.buildRelevanceQuery(db, sanitizeOr(c.text), project)) as unknown as Array<{
        content: string;
      }>;
      let lit = queryCache.get(c.text);
      if (!lit) {
        lit = __internals.vectorLiteral((await embed([c.text]))[0]);
        queryCache.set(c.text, lit);
      }
      const em = (await db.unsafe(
        `SELECT content FROM memories WHERE ${BENCH_COL} IS NOT NULL AND (memory_type != 'project_fact' OR project = $1) ORDER BY ${BENCH_COL} <=> $2::vector LIMIT 20`,
        [project, lit],
      )) as Array<{ content: string }>;
      latencies.push(performance.now() - t0);

      const relevant = topicIds.get(c.topicIdx) ?? new Set<string>();
      for (const [w, bucket] of perWeight) {
        const s = score(wrrf([kw, em], [1, w]).slice(0, 5), relevant);
        if (s) bucket.push({ s, kind: c.kind });
      }
      const sk = score(kw.slice(0, 5), relevant);
      if (sk) anchors.keyword.push({ s: sk, kind: c.kind });
      const se = score(em.slice(0, 5), relevant);
      if (se) anchors.embed.push({ s: se, kind: c.kind });
    }
    latencies.sort((a, b) => a - b);
    const avg = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0);
    const recallOf = (xs: PerWeight, kind?: Case["kind"]) => {
      const sel = kind ? xs.filter((x) => x.kind === kind) : xs;
      return avg(sel.map((x) => x.s.recall));
    };
    console.log(`anchors: keyword recall ${recallOf(anchors.keyword).toFixed(3)} | embed recall ${recallOf(anchors.embed).toFixed(3)} (para ${recallOf(anchors.embed, "paraphrase").toFixed(3)})`);
    for (const [w, xs] of perWeight) {
      const row = table.find((r) => r.w === w) as Row;
      row.synRecall = recallOf(xs).toFixed(3);
      row.synDirect = recallOf(xs, "direct").toFixed(3);
      row.synPara = recallOf(xs, "paraphrase").toFixed(3);
      row.p50 = pct(latencies, 50).toFixed(1);
      row.p95 = pct(latencies, 95).toFixed(1);
      console.log(
        `weight ${w}x: recall ${row.synRecall} | direct ${row.synDirect} | para ${row.synPara} | p50 ${row.p50}ms p95 ${row.p95}ms`,
      );
    }
  } finally {
    await db.close({ timeout: 0 });
  }
}

console.log("\n=== sweep table ===");
console.log("weight  real-hit@5  syn-recall  syn-direct  syn-para  p50ms  p95ms");
for (const r of table.sort((a, b) => a.w - b.w)) {
  console.log(
    `${String(r.w).padEnd(7)} ${(r.real ?? "-").padEnd(11)} ${(r.synRecall ?? "-").padEnd(11)} ${(r.synDirect ?? "-").padEnd(11)} ${(r.synPara ?? "-").padEnd(9)} ${(r.p50 ?? "-").padEnd(6)} ${r.p95 ?? "-"}`,
  );
}

await __internals.dispose();
