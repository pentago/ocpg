// Gate 1 for smart writes: runs the production smart-write path (embedding
// prefilter + judge verdict) against a hand-labeled set of memory pairs and
// reports per-category accuracy.
//
// bun bench/judge.ts [--threshold 0.7]
//
// Three categories:
//   duplicate  the new text restates the existing one - judge must say
//              "duplicate"; a store is a miss (feeds consolidate).
//   update     the new text supersedes the existing one - judge must say
//              "update" with the right id and merged content.
//   distinct   same topic, genuinely different fact - judge must say "new".
//              A "duplicate" verdict here LOSES INFORMATION permanently: this
//              is the hard gate. Zero false-duplicates required to ship.
//
// Pairs run one at a time against the live dev DB (fixture project, cleaned
// up at the end) so the only fixture candidate is the pair's own "existing"
// memory; the real corpus may still supply the other top-3 candidates, same
// as production.
import ocpg from "../ocpg.ts";

const { __internals } = ocpg;

const FIXTURE_PROJECT = "/tmp/ocpg-judge-bench";
const thresholdArg = process.argv.find((a) => a.startsWith("--threshold="));
const THRESHOLD = thresholdArg ? Number(thresholdArg.split("=")[1]) : __internals.SIMILAR_THRESHOLD;

type Pair = { existing: string; incoming: string };
const PAIRS: Record<"duplicate" | "update" | "distinct", Pair[]> = {
  duplicate: [
    {
      existing: "The production database runs Postgres 16 on port 5432.",
      incoming: "Postgres 16 is the production database version, listening on port 5432.",
    },
    {
      existing: "Releases are tagged only from the main branch after CI passes.",
      incoming: "We only tag releases off main once CI is green.",
    },
    {
      existing: "The staging API key rotates every 30 days and lives in Vault.",
      incoming: "Staging API credentials are stored in Vault and rotate monthly.",
    },
    {
      existing: "Never run migrations against production without a backup first.",
      incoming: "Always take a backup before running production migrations.",
    },
    {
      existing: "The frontend build requires Node 20; Node 18 fails on the crypto polyfill.",
      incoming: "Building the frontend on Node 18 breaks because of the crypto polyfill - use Node 20.",
    },
    {
      existing: "User prefers dark-themed diffs and compact tables in all reports.",
      incoming: "Reports should use compact tables and dark diff themes - that is the user's standing preference.",
    },
    {
      existing: "The Redis cache for sessions expires after 24 hours of inactivity.",
      incoming: "Session entries in Redis expire a day after last activity.",
    },
    {
      existing: "CI runs bun test against a live Postgres service container before merge.",
      incoming: "Before merging, CI executes the bun test suite against a real Postgres container.",
    },
  ],
  update: [
    {
      existing: "The staging database runs Postgres 15 on port 5432.",
      incoming: "The staging database was upgraded to Postgres 16 last week.",
    },
    {
      existing: "Deploys happen manually via `make deploy` from a maintainer laptop.",
      incoming: "Deploys moved to GitHub Actions: pushing a tag now triggers the pipeline.",
    },
    {
      existing: "The API rate limit is 100 requests per minute per key.",
      incoming: "The API rate limit was raised to 500 requests per minute per key after the caching layer shipped.",
    },
    {
      existing: "The team uses Jira for issue tracking.",
      incoming: "The team migrated issue tracking from Jira to Linear in March.",
    },
    {
      existing: "bge-m3 is the embedding model used for semantic search.",
      incoming: "Semantic search embeddings were switched from bge-m3 to jina-v3 for the multilingual corpus.",
    },
    {
      existing: "The backup job runs nightly at 02:00 UTC.",
      incoming: "After the incident, backups run every 6 hours, not just nightly.",
    },
    {
      existing: "The monorepo uses npm workspaces.",
      incoming: "The monorepo migrated from npm workspaces to pnpm workspaces.",
    },
    {
      existing: "Feature flags are managed in LaunchDarkly.",
      incoming: "Feature flags moved from LaunchDarkly to a self-hosted Flagsmith instance.",
    },
  ],
  distinct: [
    {
      existing: "The production database runs Postgres 16 on port 5432.",
      incoming: "The analytics replica runs Postgres 16 on port 5433 with logical replication.",
    },
    {
      existing: "CI runs bun test against a live Postgres container before merge.",
      incoming: "CI lint failures were caused by a biome version mismatch between the runner image and package.json.",
    },
    {
      existing: "The Redis cache for sessions expires after 24 hours.",
      incoming: "Redis maxmemory is capped at 512MB with an allkeys-lru eviction policy.",
    },
    {
      existing: "Releases are tagged only from the main branch after CI passes.",
      incoming: "Hotfix branches are named hotfix/<ticket> and branch off the latest release tag.",
    },
    {
      existing: "The staging API key rotates every 30 days and lives in Vault.",
      incoming: "Vault unsealing requires two of three admin key shares after every restart.",
    },
    {
      existing: "User prefers compact tables in reports.",
      incoming: "User asked for the onboarding docs to be rewritten for non-engineers.",
    },
    {
      existing: "The frontend requires Node 20.",
      incoming: "The backend was pinned to Python 3.12 because the ORM drops 3.13 support.",
    },
    {
      existing: "Migrations must never run against production without a backup.",
      incoming: "The migration framework squashes all migrations older than one year into a baseline.",
    },
    {
      existing: "bge-m3 is the embedding model for semantic search.",
      incoming: "Semantic search latency p95 dropped to 40ms after moving embeddings to the GPU host.",
    },
    {
      existing: "The backup job runs nightly at 02:00 UTC.",
      incoming: "Restores are tested quarterly by booting the backup into a scratch namespace.",
    },
  ],
};

type Outcome =
  | { kind: "no-candidate"; similarity: number }
  | { kind: "new"; similarity: number }
  | { kind: "duplicate"; id: number; similarity: number }
  | { kind: "update"; id: number; merged: string; similarity: number }
  | { kind: "judge-failed"; similarity: number };

async function check(pair: Pair): Promise<{ outcome: Outcome; existingId: number }> {
  const inserted = await __internals.sql`
    INSERT INTO memories (content, tags, session_id, project)
    VALUES (${pair.existing}, ${__internals.sql.array(["judge-bench"], "text")}, 'judge-bench', ${FIXTURE_PROJECT})
    RETURNING id
  ` as { id: number }[];
  const existingId = inserted[0].id;
  await __internals.embedAndStore(existingId, pair.existing);

  try {
    const vecs = await __internals.embed([pair.incoming], 15_000);
    if (!vecs) return { outcome: { kind: "judge-failed", similarity: 0 }, existingId };
    const similar = await __internals.findSimilarMemories(__internals.vectorLiteral(vecs[0]), FIXTURE_PROJECT);
    const own = similar.find((s) => s.id === existingId);
    const candidates = similar.filter((s) => s.similarity >= THRESHOLD);
    if (candidates.length === 0) {
      return { outcome: { kind: "no-candidate", similarity: own?.similarity ?? similar[0]?.similarity ?? 0 }, existingId };
    }
    const raw = await __internals.judgeRaw(__internals.buildWritePrompt(pair.incoming, candidates));
    if (!raw) return { outcome: { kind: "judge-failed", similarity: own?.similarity ?? 0 }, existingId };
    const verdict = __internals.parseWriteVerdict(raw, candidates.map((c) => c.id));
    const sim = own?.similarity ?? 0;
    if (!verdict) return { outcome: { kind: "judge-failed", similarity: sim }, existingId };
    if (verdict.verdict === "new") return { outcome: { kind: "new", similarity: sim }, existingId };
    if (verdict.verdict === "duplicate") return { outcome: { kind: "duplicate", id: verdict.id, similarity: sim }, existingId };
    return { outcome: { kind: "update", id: verdict.id, merged: verdict.mergedContent, similarity: sim }, existingId };
  } finally {
    await __internals.sql`DELETE FROM memories WHERE id = ${existingId}`;
  }
}

function fmt(o: Outcome): string {
  switch (o.kind) {
    case "no-candidate":
      return `no-candidate (sim ${o.similarity.toFixed(3)})`;
    case "new":
      return `new (sim ${o.similarity.toFixed(3)})`;
    case "duplicate":
      return `duplicate #${o.id} (sim ${o.similarity.toFixed(3)})`;
    case "update":
      return `update #${o.id} (sim ${o.similarity.toFixed(3)})`;
    case "judge-failed":
      return `JUDGE FAILED (sim ${o.similarity.toFixed(3)})`;
  }
}

// Probes: the whole gate is meaningless without the embed model and the judge.
const ollamaUp = await fetch(`${__internals.ollamaBase}/api/tags`, { signal: AbortSignal.timeout(1500) })
  .then((r) => r.ok)
  .catch(() => false);
if (!ollamaUp) {
  console.error(`Ollama not reachable at ${__internals.ollamaBase}`);
  process.exit(2);
}
if (__internals.judgeModel.includes("/")) {
  console.error("judge bench needs an Ollama judge model (OCPG_JUDGE_MODEL without a provider prefix)");
  process.exit(2);
}

console.log(`judge model: ${__internals.judgeModel} | threshold: ${THRESHOLD} | embed: warm-up...`);
await __internals.embed(["warmup"], 15_000);

let falseDupes = 0;
let falseUpdates = 0;
let judgeFailures = 0;
const summary: Record<string, { pass: number; total: number }> = {};

for (const [category, pairs] of Object.entries(PAIRS)) {
  console.log(`\n== ${category} (expected: ${category === "distinct" ? "new" : category}) ==`);
  let pass = 0;
  for (const pair of pairs) {
    const { outcome, existingId } = await check(pair);
    let ok: boolean;
    if (category === "duplicate") {
      // A duplicate verdict loses nothing; "update" preserves the info too
      // but piles text into one row - count it as a soft miss (note, not fail).
      ok = outcome.kind === "duplicate";
    } else if (category === "update") {
      // Must target the pair's own memory - updating an unrelated row would
      // clobber it.
      ok = outcome.kind === "update" && outcome.id === existingId;
    } else {
      // distinct: only "new" (or no candidate at all) is correct. A duplicate
      // verdict means the fact is NEVER stored - information lost. An update
      // verdict rewrites an unrelated memory - also information loss.
      ok = outcome.kind === "new" || outcome.kind === "no-candidate";
      if (outcome.kind === "duplicate") falseDupes++;
      if (outcome.kind === "update") falseUpdates++;
    }
    if (outcome.kind === "judge-failed") judgeFailures++;
    if (ok) pass++;
    console.log(`  ${ok ? "PASS" : "FAIL"}  ${fmt(outcome)}`);
    console.log(`       existing: ${pair.existing}`);
    console.log(`       incoming: ${pair.incoming}`);
    if (outcome.kind === "update") console.log(`       merged:   ${outcome.merged}`);
  }
  summary[category] = { pass, total: pairs.length };
  console.log(`  -> ${pass}/${pairs.length}`);
}

await __internals.sql`DELETE FROM memories WHERE project = ${FIXTURE_PROJECT}`;
await __internals.sql.close({ timeout: 0 }).catch(() => {});

console.log("\n== summary ==");
for (const [cat, s] of Object.entries(summary)) {
  console.log(`${cat.padEnd(10)} ${s.pass}/${s.total}`);
}
console.log(`\nFALSE DUPLICATES on distinct pairs: ${falseDupes}`);
console.log(`FALSE UPDATES on distinct pairs:    ${falseUpdates}`);
console.log(`judge failures (degraded to insert): ${judgeFailures}`);
if (falseDupes > 0 || falseUpdates > 0) {
  console.log("\nGATE: FAIL - the judge loses information on distinct pairs. Do not ship.");
  process.exit(1);
}
console.log("\nGATE: PASS (zero false-duplicates/false-updates on distinct pairs)");
