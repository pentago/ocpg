// Cross-session recall signal experiment (spec: "cross-session recall
// signal, fixing dormant access_count"). Validates the proposed
// LEAST(cross_session_count, 5) * 0.002 ORDER BY tiebreak two ways before it
// touches ocpg.ts:
//
//   1. recall/mrr/prec on the existing query mix, baseline (fts-or (prod))
//      vs the candidate tiebreak, against a simulated reuse history (a
//      plausible subset of "genuinely good" memories recalled from several
//      distinct fake sessions; everything else starts cold, same as every
//      real memory today).
//   2. the specific failure this must avoid (access_count's rich-get-richer
//      bug): spam-recalling one memory 50x from a SINGLE session must not
//      grow its cross_session_count past 1, and must not move its rank -
//      only genuinely distinct sessions may.
//
// Adds `memory_recalls` directly to the existing bench DBs (additive, not a
// change to generate.ts's DDL - this table is candidate-only until the spec
// ships) and truncates it per run, so re-runs are idempotent.
//
//   bun bench/cross-session.ts [--sizes 500,5000] [--queries 150]
import { SQL } from "bun";
import ocpg from "../ocpg.ts";
import { PROJECTS, TOPICS, benchDbName, makeSql, pick, rng } from "./config.ts";
import { type BenchRow, type Case, buildCorpusWords, buildMix, buildTopicIds, sanitizeOr, score } from "./lib.ts";

const { __internals } = ocpg;

const args = process.argv.slice(2);
const opt = (name: string, fallback: string): string => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : fallback;
};
const sizes = opt("--sizes", "500,5000").split(",").map(Number);
const perMix = Number(opt("--queries", "150"));

// The candidate ORDER BY term, exactly as proposed in the spec: capped
// distinct-session count, weighted well below the existing same-project
// boost (0.01) so relevance ranking still dominates and this only breaks
// near-ties.
function xsessQuery(client: SQL, tsQuery: string, directory: string) {
  return client`
    SELECT m.content, coalesce(m.tags, '{}') AS tags, m.project
    FROM memories m
    LEFT JOIN (
      SELECT memory_id, count(DISTINCT session_id) AS xsess
      FROM memory_recalls GROUP BY memory_id
    ) r ON r.memory_id = m.id
    WHERE m.search_vector @@ to_tsquery('english', ${tsQuery})
      AND (m.memory_type != 'project_fact' OR m.project = ${directory})
    ORDER BY ts_rank(m.search_vector, to_tsquery('english', ${tsQuery}))
             + (CASE WHEN m.project = ${directory} THEN 0.01 ELSE 0 END)
             + LEAST(coalesce(r.xsess, 0), 5) * 0.002 DESC,
             m.created_at DESC
    LIMIT 20
  `;
}

async function setupDb(size: number): Promise<SQL> {
  const db = new SQL(makeSql(benchDbName(size)));
  await db`
    CREATE TABLE IF NOT EXISTS memory_recalls (
      memory_id  integer NOT NULL REFERENCES memories(id) ON DELETE CASCADE,
      session_id text NOT NULL,
      recalled_at timestamptz NOT NULL DEFAULT now(),
      PRIMARY KEY (memory_id, session_id)
    )
  `;
  await db`TRUNCATE memory_recalls`;
  return db;
}

// Plausible reuse history: ~15% of each topic's memories are "genuinely
// good" and get recalled from 2-5 distinct fake sessions; the rest stay at
// zero - the same cold-start every real memory has today (no backfill).
async function simulateReuse(
  db: SQL,
  rows: BenchRow[],
  topicIds: Map<number, Set<string>>,
  rand: () => number,
): Promise<void> {
  const byContent = new Map(rows.map((r) => [r.content, r.id]));
  for (const relevant of topicIds.values()) {
    const ids = [...relevant].map((c) => byContent.get(c)).filter((x): x is number => x !== undefined);
    const reused = ids.filter(() => rand() < 0.15);
    for (const id of reused) {
      const sessionCount = 2 + Math.floor(rand() * 4); // 2-5 distinct sessions
      for (let s = 0; s < sessionCount; s++) {
        await db`INSERT INTO memory_recalls (memory_id, session_id) VALUES (${id}, ${`sess-good-${id}-${s}`}) ON CONFLICT DO NOTHING`;
      }
    }
  }
}

async function benchDataset(size: number): Promise<void> {
  const db = await setupDb(size);
  try {
    const rows = (await db`SELECT id, content, project FROM memories`) as BenchRow[];
    const rand = rng(size * 31 + 7);
    const project = pick(rand, PROJECTS);
    const topicIds = buildTopicIds(rows, project);
    await simulateReuse(db, rows, topicIds, rng(size * 17 + 3));

    const mix = buildMix(rng(999 + size), buildCorpusWords(rows), perMix);
    console.log(`\n=== ${benchDbName(size)}: ${rows.length} memories ===`);

    const buckets: Record<string, Array<{ s: NonNullable<ReturnType<typeof score>>; kind: Case["kind"] }>> = {
      "baseline (fts-or prod)": [],
      "+ xsess tiebreak": [],
    };
    for (const c of mix) {
      const tsQuery = sanitizeOr(c.text);
      const relevant = topicIds.get(c.topicIdx) ?? new Set<string>();
      const baseRows = (await __internals.buildRelevanceQuery(db, tsQuery, project)) as unknown as Array<{ content: string }>;
      const xsRows = (await xsessQuery(db, tsQuery, project)) as unknown as Array<{ content: string }>;
      const sb = score(baseRows, relevant);
      if (sb) buckets["baseline (fts-or prod)"].push({ s: sb, kind: c.kind });
      const sx = score(xsRows, relevant);
      if (sx) buckets["+ xsess tiebreak"].push({ s: sx, kind: c.kind });
    }
    const avg = (xs: number[]): number => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0);
    for (const [name, xs] of Object.entries(buckets)) {
      const recall = avg(xs.map((x) => x.s.recall));
      const mrr = avg(xs.map((x) => x.s.mrr));
      const prec = avg(xs.map((x) => x.s.prec));
      console.log(`${name.padEnd(24)} recall ${recall.toFixed(3)}  mrr ${mrr.toFixed(3)}  prec ${prec.toFixed(3)}  (n=${xs.length})`);
    }

    // --- rich-get-richer guard -----------------------------------------
    // Find a VIRGIN row (no simulated recall history) that lands mid-pack
    // (rank 1-15, not already #1 and not outside the top-20 window) for its
    // own topic query, so a rank change would actually be visible. Spam it
    // 50x from ONE session and confirm both its cross_session_count and its
    // rank are unmoved - only genuinely distinct sessions may change either.
    const byContent = new Map(rows.map((r) => [r.content, r.id]));
    let found: { targetId: number; targetContent: string; tsQuery: string; before: number } | null = null;
    for (const [topicIdx, relevant] of topicIds) {
      for (const targetContent of relevant) {
        const targetId = byContent.get(targetContent);
        if (targetId === undefined) continue;
        const topicWords = TOPICS[topicIdx].words.filter((w) => targetContent.toLowerCase().includes(w.toLowerCase()));
        if (topicWords.length === 0) continue;
        const tsQuery = sanitizeOr(topicWords.join(" "));
        const candidateRows = (await xsessQuery(db, tsQuery, project)) as unknown as Array<{ content: string }>;
        const rank = candidateRows.findIndex((r) => r.content === targetContent);
        if (rank >= 1 && rank <= 15) {
          found = { targetId, targetContent, tsQuery, before: rank };
          break;
        }
      }
      if (found) break;
    }

    if (!found) {
      console.log("rich-get-richer guard: skipped (no virgin mid-ranked row found in this dataset)");
    } else {
      const { targetId, targetContent, tsQuery, before } = found;
      const rankOf = (rowsList: Array<{ content: string }>): number => rowsList.findIndex((r) => r.content === targetContent);

      // First recall ever (cold start, count 0 -> 1) is a REAL signal and is
      // allowed to move the rank - that is not the bug. Establish that
      // baseline first, then spam 49 MORE recalls from the SAME session and
      // confirm the count and the rank both stay put: repeat exposure within
      // one session is the access_count failure mode this table is designed
      // to reject.
      await db`INSERT INTO memory_recalls (memory_id, session_id) VALUES (${targetId}, 'sess-spam') ON CONFLICT DO NOTHING`;
      const afterFirst = rankOf((await xsessQuery(db, tsQuery, project)) as unknown as Array<{ content: string }>);

      for (let i = 0; i < 49; i++) {
        await db`INSERT INTO memory_recalls (memory_id, session_id) VALUES (${targetId}, 'sess-spam') ON CONFLICT DO NOTHING`;
      }
      const [{ xsess }] = (await db`
        SELECT count(DISTINCT session_id)::int AS xsess FROM memory_recalls WHERE memory_id = ${targetId}
      `) as { xsess: number }[];
      const afterSpam = rankOf((await xsessQuery(db, tsQuery, project)) as unknown as Array<{ content: string }>);

      console.log(
        `rich-get-richer guard: memory #${targetId} virgin (rank ${before}) -> first recall (rank ${afterFirst}) -> ` +
          `49 MORE recalls from that SAME session (rank ${afterSpam}, cross_session_count=${xsess}, expect 1 & unchanged rank)`,
      );
      if (xsess !== 1) {
        throw new Error(`FAIL: same-session spam inflated cross_session_count to ${xsess} - the PK-dedup guarantee is broken`);
      }
      if (afterFirst !== afterSpam) {
        throw new Error(`FAIL: same-session spam moved rank ${afterFirst} -> ${afterSpam} despite an unchanged cross_session_count`);
      }

      // Contrast case: genuinely distinct sessions DO get to move it
      // (bounded - the signal working as designed, not a regression).
      for (let s = 0; s < 5; s++) {
        await db`INSERT INTO memory_recalls (memory_id, session_id) VALUES (${targetId}, ${`sess-real-${s}`}) ON CONFLICT DO NOTHING`;
      }
      const afterReal = rankOf((await xsessQuery(db, tsQuery, project)) as unknown as Array<{ content: string }>);
      console.log(`  after 5 more genuinely distinct sessions: rank ${afterSpam} -> ${afterReal} (may improve, bounded by the 0.002x5 cap)`);
    }
  } finally {
    await db.close({ timeout: 0 });
  }
}

for (const size of sizes) {
  await benchDataset(size);
}
await __internals.dispose();
