// Stress-tests memory_consolidate's meaning-pass threshold
// (CONSOLIDATE_EMBED_THRESHOLD) against Quora Question Pairs (QQP): ~400k
// real, human-labeled question pairs, vastly larger and messier than the
// 26 hand-written pairs the threshold was calibrated on. Runs a balanced
// sample through the exact production embedding pipeline (__internals.embed,
// bge-m3) and scores the same cosine-similarity formula consolidate()'s
// meaning pass uses, plus a negative control on isTemplatedAutoLog (QQP
// questions should never match a filter meant for ocpg's own auto-generated
// content). See the qqp-consolidate spec (repo history) for full rationale;
// this is NOT a change to CONSOLIDATE_EMBED_THRESHOLD, only a measurement.
//
// Setup (one-off, not part of `bun test` or CI):
//   python3 -m venv .venv && .venv/bin/pip install duckdb
//   .venv/bin/python bench/qqp-prepare.py   # writes bench/data/qqp-sample.ndjson (gitignored)
//   bun bench/qqp-consolidate.ts [--file bench/data/qqp-sample.ndjson] [--ollama http://localhost:11434]
//
// Uses a dedicated scratch database (`qqp-consolidate-bench`) - never
// `agent-memory-bench-*`, never the real DB. Requires the OCPG_* user to
// hold CREATEDB.
import { SQL } from "bun";
import ocpg from "../ocpg.ts";
import { makeSql } from "./config.ts";

const { __internals } = ocpg;

const args = process.argv.slice(2);
const opt = (name: string, fallback: string): string => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : fallback;
};
const file = opt("--file", "bench/data/qqp-sample.ndjson");
const ollama = opt("--ollama", process.env.OCPG_BENCH_OLLAMA ?? "http://localhost:11434");
__internals.setOllamaBase(ollama);

const DB_NAME = "qqp-consolidate-bench";
const PROJECT = "/bench/qqp-consolidate"; // single fake project shared by every row - not testing scoping

type Pair = { question1: string; question2: string; label: 0 | 1 };

const raw = await Bun.file(file).text();
const pairs: Pair[] = raw
  .trim()
  .split("\n")
  .filter(Boolean)
  .map((l) => JSON.parse(l));
if (pairs.length === 0) throw new Error(`${file} is empty - run bench/qqp-prepare.py first`);
console.log(
  `Loaded ${pairs.length} QQP pairs from ${file} (${pairs.filter((p) => p.label === 1).length} duplicate / ${pairs.filter((p) => p.label === 0).length} distinct)`,
);

// Schema mirrors deploy/init/01-init.sh's memories table (this is what
// memory_consolidate's meaning pass actually queries); indexes/columns this
// bench never touches (tags/search_vector gin, memory_recalls) are omitted.
// qqp_ground_truth is a separate mapping table, per spec, so scoring never
// touches the schema under test.
const DDL = `
CREATE EXTENSION IF NOT EXISTS vector;
CREATE TABLE memories (
  id            serial PRIMARY KEY,
  content       text        NOT NULL,
  tags          text[]      NOT NULL DEFAULT '{}',
  session_id    text,
  project       text,
  created_at    timestamptz DEFAULT now(),
  memory_type   text        NOT NULL DEFAULT 'project_fact',
  embedding     vector(1024),
  CONSTRAINT memories_type_check CHECK (memory_type IN ('stack_fact', 'project_fact', 'episodic'))
);
CREATE INDEX idx_memories_embedding ON memories USING hnsw (embedding vector_cosine_ops);

CREATE TABLE qqp_ground_truth (
  memory_id_1  integer NOT NULL REFERENCES memories(id),
  memory_id_2  integer NOT NULL REFERENCES memories(id),
  is_duplicate boolean NOT NULL
);
`;

const admin = new SQL(makeSql("postgres"));
await admin`DROP DATABASE IF EXISTS ${admin(DB_NAME)}`;
await admin`CREATE DATABASE ${admin(DB_NAME)}`;
await admin.close({ timeout: 0 });

const db = new SQL(makeSql(DB_NAME));
try {
  await db.unsafe(DDL);

  console.log("Inserting memories (2 rows per pair) + ground-truth mapping...");
  const BATCH = 250; // pairs per transaction (500 inserts)
  const idPairs: Array<[number, number]> = [];
  for (let b = 0; b < pairs.length; b += BATCH) {
    const slice = pairs.slice(b, b + BATCH);
    await db.begin(async (tx) => {
      for (const p of slice) {
        const [r1] = (await tx`
          INSERT INTO memories (content, project, memory_type) VALUES (${p.question1}, ${PROJECT}, 'project_fact') RETURNING id
        `) as { id: number }[];
        const [r2] = (await tx`
          INSERT INTO memories (content, project, memory_type) VALUES (${p.question2}, ${PROJECT}, 'project_fact') RETURNING id
        `) as { id: number }[];
        idPairs.push([r1.id, r2.id]);
        await tx`
          INSERT INTO qqp_ground_truth (memory_id_1, memory_id_2, is_duplicate) VALUES (${r1.id}, ${r2.id}, ${p.label === 1})
        `;
      }
    });
  }
  console.log(`Inserted ${idPairs.length * 2} memories, ${idPairs.length} ground-truth rows.`);

  console.log("Embedding rows via the real pipeline (__internals.embed, bge-m3)...");
  const allRows = (await db`SELECT id, content FROM memories ORDER BY id`) as { id: number; content: string }[];
  const EMBED_BATCH = 100;
  let embedded = 0;
  let failedBatches = 0;
  for (let b = 0; b < allRows.length; b += EMBED_BATCH) {
    const slice = allRows.slice(b, b + EMBED_BATCH);
    const vecs = await __internals.embed(
      slice.map((r) => r.content),
      30_000,
    );
    if (!vecs) {
      failedBatches++;
      continue;
    }
    await db.begin(async (tx) => {
      for (let i = 0; i < slice.length; i++) {
        await tx`UPDATE memories SET embedding = ${__internals.vectorLiteral(vecs[i])}::vector WHERE id = ${slice[i].id}`;
      }
    });
    embedded += slice.length;
    if (b % 1000 === 0) console.log(`  embedded ${embedded}/${allRows.length}`);
  }
  console.log(`Embedded ${embedded}/${allRows.length} rows (${failedBatches} batches failed - Ollama unavailable for those).`);

  // --- Negative control: isTemplatedAutoLog targets a specific fixed
  // sentence shape from ocpg's own auto-generated content (background-task
  // logs, session-compaction summaries, per-app checklists). QQP questions
  // are ordinary natural language and should never match it.
  const [{ n: templated }] = (await db`
    SELECT count(*)::int AS n FROM memories WHERE ${__internals.isTemplatedAutoLog(db)}
  `) as { n: number }[];
  console.log(`\nExclusion filter (isTemplatedAutoLog) fired on ${templated}/${allRows.length} QQP rows (expected: 0).`);

  // --- Same cosine-similarity formula consolidate()'s meaning pass uses ---
  const scored = (await db`
    SELECT g.is_duplicate, (1 - (m1.embedding <=> m2.embedding))::float8 AS cosine
    FROM qqp_ground_truth g
    JOIN memories m1 ON m1.id = g.memory_id_1
    JOIN memories m2 ON m2.id = g.memory_id_2
    WHERE m1.embedding IS NOT NULL AND m2.embedding IS NOT NULL
  `) as { is_duplicate: boolean; cosine: number }[];
  console.log(`Scored ${scored.length}/${pairs.length} pairs (rest skipped - embedding unavailable).`);

  const dup = scored.filter((r) => r.is_duplicate).map((r) => r.cosine);
  const dist = scored.filter((r) => !r.is_duplicate).map((r) => r.cosine);
  const stats = (xs: number[]) => ({
    min: Math.min(...xs),
    max: Math.max(...xs),
    mean: xs.reduce((a, b) => a + b, 0) / xs.length,
  });

  console.log("\n=== Calibration table (QQP sample, cf. bench/README.md's 26-pair table) ===");
  const d1 = stats(dup);
  const d0 = stats(dist);
  console.log("category  | min   | max   | mean  | n");
  console.log(`duplicate | ${d1.min.toFixed(3)} | ${d1.max.toFixed(3)} | ${d1.mean.toFixed(3)} | ${dup.length}`);
  console.log(`distinct  | ${d0.min.toFixed(3)} | ${d0.max.toFixed(3)} | ${d0.mean.toFixed(3)} | ${dist.length}`);

  console.log("\n=== Threshold sweep ===");
  console.log("threshold | precision | recall | FPR   | TP     FP     FN     TN");
  const thresholds = [0.75, 0.8, __internals.CONSOLIDATE_EMBED_THRESHOLD, 0.86, 0.9];
  for (const t of thresholds) {
    let tp = 0;
    let fp = 0;
    let fn = 0;
    let tn = 0;
    for (const r of scored) {
      const predicted = r.cosine >= t;
      if (predicted && r.is_duplicate) tp++;
      else if (predicted && !r.is_duplicate) fp++;
      else if (!predicted && r.is_duplicate) fn++;
      else tn++;
    }
    const precision = tp + fp > 0 ? tp / (tp + fp) : 0;
    const recall = tp + fn > 0 ? tp / (tp + fn) : 0;
    const fpr = fp + tn > 0 ? fp / (fp + tn) : 0;
    const flag = t === __internals.CONSOLIDATE_EMBED_THRESHOLD ? " <- shipped" : "";
    console.log(
      `${t.toFixed(2)}      | ${precision.toFixed(3)}     | ${recall.toFixed(3)}  | ${fpr.toFixed(3)} | ${tp}    ${fp}    ${fn}    ${tn}${flag}`,
    );
  }

  // --- Detail cross-check re-run (spec: "detail cross-check for
  // consolidation's meaning pass", 2026-09-20) - only applies to pairs the
  // similarity pass already flagged as candidates (cosine >= shipped
  // threshold), exactly like consolidate()'s real gate order.
  console.log("\n=== Detail cross-check applied on top of the shipped threshold (0.83) ===");
  const T = __internals.CONSOLIDATE_EMBED_THRESHOLD;
  const scoredWithText = (await db`
    SELECT g.is_duplicate, (1 - (m1.embedding <=> m2.embedding))::float8 AS cosine, m1.content AS c1, m2.content AS c2
    FROM qqp_ground_truth g
    JOIN memories m1 ON m1.id = g.memory_id_1
    JOIN memories m2 ON m2.id = g.memory_id_2
    WHERE m1.embedding IS NOT NULL AND m2.embedding IS NOT NULL
  `) as { is_duplicate: boolean; cosine: number; c1: string; c2: string }[];

  const candidates = scoredWithText.filter((r) => r.cosine >= T);
  let cleanTp = 0;
  let cleanFp = 0;
  let uncertainTp = 0;
  let uncertainFp = 0;
  for (const r of candidates) {
    const conflicts = __internals.detailConflicts(__internals.extractDetails(r.c1), __internals.extractDetails(r.c2));
    const conflicting = conflicts.length > 0;
    if (conflicting && r.is_duplicate) uncertainTp++;
    else if (conflicting && !r.is_duplicate) uncertainFp++;
    else if (!conflicting && r.is_duplicate) cleanTp++;
    else cleanFp++;
  }
  const totalDup = scored.filter((r) => r.is_duplicate).length;
  const totalDist = scored.filter((r) => !r.is_duplicate).length;
  const baselineFp = candidates.filter((r) => !r.is_duplicate).length;
  const baselineTp = candidates.filter((r) => r.is_duplicate).length;

  console.log(`Candidates at threshold (cosine >= ${T}): ${candidates.length} (${baselineTp} true duplicate / ${baselineFp} distinct)`);
  console.log(`  -> clean (no detail conflict, auto-merged same as before): TP=${cleanTp} FP=${cleanFp}`);
  console.log(`  -> [meaning-uncertain] (detail conflict, NOT merged, flagged for review): TP=${uncertainTp} FP=${uncertainFp}`);
  console.log("");
  const precisionAuto = cleanTp + cleanFp > 0 ? cleanTp / (cleanTp + cleanFp) : 0;
  const recallAutoOnly = totalDup > 0 ? cleanTp / totalDup : 0;
  const recallIncludingReview = totalDup > 0 ? (cleanTp + uncertainTp) / totalDup : 0;
  const fprAuto = totalDist > 0 ? cleanFp / totalDist : 0;
  console.log(`precision (auto-merged only):            ${precisionAuto.toFixed(3)} (baseline: ${(baselineTp / candidates.length).toFixed(3)})`);
  console.log(`recall (auto-merged only, silent):        ${recallAutoOnly.toFixed(3)}`);
  console.log(`recall (auto-merged + flagged for review): ${recallIncludingReview.toFixed(3)} (baseline: ${(baselineTp / totalDup).toFixed(3)})`);
  console.log(`FPR (auto-merged only):                    ${fprAuto.toFixed(3)} (baseline: ${(baselineFp / totalDist).toFixed(3)})`);
  console.log("");
  console.log(
    `Previously-false-positive pairs now correctly routed to [meaning-uncertain] instead of a silent merge: ${uncertainFp}/${baselineFp} (${((uncertainFp / baselineFp) * 100).toFixed(1)}%)`,
  );
  console.log(
    `Previously-true-positive pairs now blocked from auto-merge (routed to [meaning-uncertain], a new review cost, not a silent loss): ${uncertainTp}/${baselineTp} (${((uncertainTp / baselineTp) * 100).toFixed(1)}%)`,
  );
  console.log(`[meaning-uncertain] bucket size (share of ALL scored pairs, reviewability check): ${candidates.length > 0 ? (((uncertainTp + uncertainFp) / scored.length) * 100).toFixed(1) : "0.0"}%`);
} finally {
  await db.close({ timeout: 0 }).catch(() => {});
  await __internals.dispose();
}
