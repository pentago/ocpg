// Benchmarks pgvector retrieval (local Ollama embeddings) against the same
// synthetic bench DBs and the same query mix/scoring as run.ts (shared via
// lib.ts - identical seeds, identical queries), plus the fts-or (prod) and
// recency-only anchors for a side-by-side table.
//
// OCPG_PORT=5433 OCPG_PASSWORD=bench bun bench/embed.ts [--sizes 500,5000,50000] [--queries 150] [--model bge-m3] [--ollama http://localhost:11434]
//
// Targets the throwaway pgvector container (bench/compose.yaml) - NOT the
// real agent-memory DB. Embeddings come from the HOST ollama (GPU); a
// containerized ollama would be CPU-only here (no nvidia-container-toolkit)
// and 50k-row embedding would take hours.
//
// The MiniLM side reuses the previous experiment's `embedding` (384-dim)
// column when its vectors verify against the host ollama's all-minilm
// (cosine >= 0.999 on samples); otherwise the column is re-embedded with
// all-minilm so both models run through this exact harness.
import { SQL } from "bun";
import ocpg from "../ocpg.ts";
import { PROJECTS, benchDbName, makeSql, pick, rng } from "./config.ts";
import { type BenchRow, type Case, buildCorpusWords, buildMix, buildTopicIds, sanitizeOr, score } from "./lib.ts";

const { __internals } = ocpg;

const args = process.argv.slice(2);
const opt = (name: string, fallback: string): string => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : fallback;
};
const sizes = opt("--sizes", "500,5000,50000").split(",").map(Number);
const perMix = Number(opt("--queries", "150"));
const model = opt("--model", "bge-m3");
const MINILM = "all-minilm";
const ollama = opt("--ollama", process.env.OCPG_BENCH_OLLAMA ?? "http://localhost:11434");

const colName = (m: string): string => (m === MINILM ? "embedding" : `embedding_${m.replace(/[^a-z0-9]+/gi, "_").toLowerCase()}`);

async function embed(texts: string[], m: string): Promise<number[][]> {
  const res = await fetch(`${ollama}/api/embed`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ model: m, input: texts }),
  });
  if (!res.ok) throw new Error(`ollama /api/embed ${m}: ${res.status} ${await res.text()}`);
  return ((await res.json()) as { embeddings: number[][] }).embeddings;
}

// Reciprocal rank fusion over ranked lists (k=60, the standard constant):
// each row scores 1/(k + 1-based rank) per list it appears in. Keyed on
// content - identical text is the same memory for ranking purposes.
const rrf = <T extends { content: string }>(lists: T[][], k = 60): T[] => {
  const scores = new Map<string, { score: number; row: T }>();
  for (const list of lists) {
    list.forEach((row, i) => {
      const e = scores.get(row.content) ?? { score: 0, row };
      e.score += 1 / (k + i + 1);
      scores.set(row.content, e);
    });
  }
  return [...scores.values()].sort((a, b) => b.score - a.score).map((e) => e.row);
};

const cosine = (a: number[], b: number[]): number => {
  let dot = 0, na = 0, nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  return dot / (Math.sqrt(na) * Math.sqrt(nb));
};

// The previous MiniLM run left a filled 384-dim column but no code. Reusing it
// keeps continuity with the old numbers, but only if this harness's all-minilm
// reproduces those vectors - otherwise the old pipeline is unknown and the
// column gets re-embedded so both sides of the table share one pipeline.
async function legacyMinilmUsable(db: SQL): Promise<boolean> {
  const sample = (await db`SELECT content, embedding FROM memories WHERE embedding IS NOT NULL ORDER BY random() LIMIT 5`) as Array<{
    content: string;
    embedding: string;
  }>;
  if (sample.length === 0) return false;
  const fresh = await embed(sample.map((r) => r.content), MINILM);
  return sample.every((r, i) => cosine(JSON.parse(r.embedding), fresh[i]) >= 0.999);
}

async function ensureColumn(db: SQL, col: string, dims: number): Promise<void> {
  await db`CREATE EXTENSION IF NOT EXISTS vector`;
  await db.unsafe(`ALTER TABLE memories ADD COLUMN IF NOT EXISTS ${col} vector(${dims})`);
}

async function fill(db: SQL, col: string, m: string): Promise<void> {
  const [{ n }] = (await db.unsafe(`SELECT count(*) AS n FROM memories WHERE ${col} IS NULL`)) as Array<{ n: number }>;
  let remaining = Number(n);
  if (remaining === 0) return;
  console.log(`  embedding ${remaining} rows with ${m} -> ${col}`);
  const t0 = performance.now();
  while (true) {
    const batch = (await db.unsafe(`SELECT id, content FROM memories WHERE ${col} IS NULL ORDER BY id LIMIT 256`)) as Array<{
      id: number;
      content: string;
    }>;
    if (batch.length === 0) break;
    const vecs: number[][] = [];
    for (let i = 0; i < batch.length; i += 32) {
      vecs.push(...(await embed(batch.slice(i, i + 32).map((r) => r.content), m)));
    }
    const ids = batch.map((r) => r.id);
    const lits = vecs.map((v) => `[${v.join(",")}]`);
    await db`UPDATE memories m SET ${db(col)} = v.e::vector
             FROM (SELECT unnest(${db.array(ids, "integer")}) AS id, unnest(${db.array(lits, "text")}) AS e) v
             WHERE m.id = v.id`;
    remaining -= batch.length;
    if (remaining > 0 && remaining % 2560 < batch.length) {
      const rate = (((performance.now() - t0) / 1000 / (Number(n) - remaining)) * remaining) | 0;
      console.log(`  ${remaining} left (~${rate}s)`);
    }
  }
  await db.unsafe(`CREATE INDEX IF NOT EXISTS idx_memories_${col} ON memories USING hnsw (${col} vector_cosine_ops)`);
}

async function benchDataset(size: number): Promise<void> {
  const db = new SQL(makeSql(benchDbName(size)));
  try {
    const rows = (await db`SELECT id, content, project FROM memories`) as BenchRow[];
    console.log(`\n=== ${benchDbName(size)}: ${rows.length} memories (ollama ${ollama}) ===`);

    // --- prepare embedding columns ---------------------------------------
    const probe = await embed(["dimension probe"], model);
    const dims = probe[0].length;
    await ensureColumn(db, colName(model), dims);
    await fill(db, colName(model), model);

    const legacyOk = await legacyMinilmUsable(db);
    if (!legacyOk) console.log(`  legacy MiniLM column does not match ollama ${MINILM} - re-embedding it`);
    else console.log(`  legacy MiniLM column verified against ollama ${MINILM} - reusing`);
    await ensureColumn(db, colName(MINILM), 384);
    await fill(db, colName(MINILM), MINILM);

    // --- strategies -------------------------------------------------------
    const queryCache = new Map<string, string>();
    const embedStrategy = (name: string, col: string, m: string) => ({
      name,
      describe: `pgvector cosine (hnsw) over ${m} embeddings; latency includes the ollama call`,
      run: async (c: SQL, q: string, d: string) => {
        let lit = queryCache.get(`${m}${q}`);
        if (!lit) {
          lit = `[${(await embed([q], m))[0].join(",")}]`;
          queryCache.set(`${m}${q}`, lit);
        }
        return (await c.unsafe(
          `SELECT content, project FROM memories WHERE (memory_type != 'project_fact' OR project = $1) ORDER BY ${col} <=> $2::vector LIMIT 5`,
          [d, lit],
        )) as Array<{ content: string; project: string }>;
      },
    });
    const strategies = [
      embedStrategy(`embed-${model}`, colName(model), model),
      embedStrategy("embed-minilm", colName(MINILM), MINILM),
      {
        name: "hybrid-rrf",
        describe: `RRF(k=60) merge of fts-or (prod) + embed-${model} 20-row candidate lists`,
        run: async (c: SQL, q: string, d: string) => {
          let lit = queryCache.get(`${model}${q}`);
          if (!lit) {
            lit = `[${(await embed([q], model))[0].join(",")}]`;
            queryCache.set(`${model}${q}`, lit);
          }
          const [kw, vec] = await Promise.all([
            __internals.buildRelevanceQuery(c, sanitizeOr(q), d) as unknown as Promise<Array<{ content: string; project: string }>>,
            c.unsafe(
              `SELECT content, project FROM memories WHERE (memory_type != 'project_fact' OR project = $1) AND ${colName(model)} IS NOT NULL ORDER BY ${colName(model)} <=> $2::vector LIMIT 20`,
              [d, lit],
            ) as Promise<Array<{ content: string; project: string }>>,
          ]);
          return rrf([kw, vec]).slice(0, 5);
        },
      },
      {
        name: "fts-or (prod)",
        describe: "OR to_tsquery + ts_rank - what ocpg ships (anchor)",
        run: (c: SQL, q: string, d: string) =>
          __internals.buildRelevanceQuery(c, sanitizeOr(q), d) as unknown as Promise<Array<{ content: string; project: string }>>,
      },
      {
        name: "recency-only",
        describe: "blind last-5 (the floor)",
        run: (c: SQL, _q: string, d: string) =>
          __internals.buildRecencyQuery(c, d) as unknown as Promise<Array<{ content: string; project: string }>>,
      },
    ];

    // --- run (identical seeds/mix/scoring to run.ts) ----------------------
    const mix = buildMix(rng(999 + size), buildCorpusWords(rows), perMix);
    console.log(`strategy          p50ms  p95ms  recall@5  mrr@5  prec@5  para-rec`);
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
      const row = [
        strategy.name.padEnd(16),
        p(50).toFixed(2).padStart(5),
        p(95).toFixed(2).padStart(6),
        avg(direct.concat(para).map((x) => x.s.recall)).toFixed(3).padStart(8),
        avg(direct.concat(para).map((x) => x.s.mrr)).toFixed(3).padStart(6),
        avg(direct.concat(para).map((x) => x.s.prec)).toFixed(3).padStart(7),
        avg(para.map((x) => x.s.recall)).toFixed(3).padStart(8),
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
