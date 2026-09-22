// Compares Ollama embedding backends for the real ocpg workload:
// host GPU (default :11434) vs the containerized CPU service (default :11444).
// Measures what the plugin actually pays: cold model load, warm single-query
// embed (the injection path), a 32-text batch (the write/backfill path), and
// the end-to-end vector half (embed + production buildVectorQuery against the
// live DB). Read-only against the database.
//
//   bun bench/ollama-backends.ts [--gpu http://localhost:11434] [--cpu http://localhost:11444] [--iters 20]
import { SQL } from "bun";
import ocpg from "../ocpg.ts";

const { __internals } = ocpg;

const args = process.argv.slice(2);
const opt = (name: string, fallback: string): string => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : fallback;
};
const backends: Array<{ name: string; base: string }> = [
  { name: "host-gpu", base: opt("--gpu", "http://localhost:11434") },
  { name: "container-cpu", base: opt("--cpu", "http://localhost:11444") },
];
const iters = Number(opt("--iters", "20"));
const MODEL = process.env.OCPG_EMBED_MODEL || "embeddinggemma:300m";

// A realistic injection-path query and a realistic memory-sized write.
const QUERY = "how do I rotate tls certificates without downtime";
const WRITE_TEXT =
  "Decision: the staging cluster drains before any node pool upgrade; in-flight jobs are checkpointed first, otherwise they are lost.";

const db = new SQL({
  hostname: process.env.OCPG_HOST || "localhost",
  port: Number(process.env.OCPG_PORT) || 5432,
  username: process.env.OCPG_USER || "ocpguser",
  password: process.env.OCPG_PASSWORD || "",
  database: process.env.OCPG_DB || "ocpg",
  ssl: "disable",
  max: 1,
});

async function embed(base: string, texts: string[], keepAlive: string | number = "30m"): Promise<number[][]> {
  const res = await fetch(`${base}/api/embed`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ model: MODEL, input: texts, keep_alive: keepAlive }),
  });
  if (!res.ok) throw new Error(`${base} /api/embed: HTTP ${res.status} ${await res.text()}`);
  return ((await res.json()) as { embeddings: number[][] }).embeddings;
}

const pct = (sorted: number[], q: number) => sorted[Math.min(sorted.length - 1, Math.floor((q / 100) * sorted.length))];
const ms = (t0: number) => performance.now() - t0;

for (const { name, base } of backends) {
  console.log(`\n=== ${name} (${base}) ===`);
  // Unload, then time the cold load (what the 750ms query budget must cover).
  await embed(base, ["unload"], 0);
  await new Promise((r) => setTimeout(r, 500));
  const t0 = performance.now();
  await embed(base, [QUERY]);
  const cold = ms(t0);

  const warm: number[] = [];
  for (let i = 0; i < iters; i++) {
    const t = performance.now();
    await embed(base, [QUERY]);
    warm.push(ms(t));
  }
  warm.sort((a, b) => a - b);

  const t1 = performance.now();
  await embed(base, Array.from({ length: 32 }, (_, i) => `${WRITE_TEXT} (variant ${i})`));
  const batch32 = ms(t1);

  // End-to-end vector half, exactly as production runs it: embed the prompt,
  // then the HNSW nearest-neighbor query against the live corpus.
  const hybrid: number[] = [];
  for (let i = 0; i < iters; i++) {
    const t = performance.now();
    const [v] = await embed(base, [QUERY]);
    await __internals.buildVectorQuery(db, __internals.vectorLiteral(v), "/bench/ollama-backends");
    hybrid.push(ms(t));
  }
  hybrid.sort((a, b) => a - b);

  console.log(
    [
      `cold-load ${cold.toFixed(0)}ms`,
      `warm-embed p50 ${pct(warm, 50).toFixed(1)}ms / p95 ${pct(warm, 95).toFixed(1)}ms`,
      `batch-32 ${batch32.toFixed(0)}ms`,
      `hybrid-path p50 ${pct(hybrid, 50).toFixed(1)}ms / p95 ${pct(hybrid, 95).toFixed(1)}ms`,
    ].join("  |  "),
  );
}

await db.close({ timeout: 0 });
await __internals.dispose();
