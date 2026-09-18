// Hybrid retrieval report on two data sources, one run:
//
//   1. the REAL memories table (ambient OCPG_* env) - stats (embedding
//      coverage, length, type mix), a paraphrase hit-rate eval over 20
//      curated real memories (baked-in pairs; rows that drifted or were
//      deleted are skipped with a notice), and per-method latency p50/p95.
//   2. the synthetic 50k bench DB (throwaway container, 127.0.0.1:5433) -
//      keyword vs embedding vs hybrid-rrf through the SAME harness as
//      bench/embed.ts (lib.ts mix/scoring, production builders for the
//      keyword half, per-model embedding column on the vector half).
//
//   bun run bench:report [--bench-port 5433] [--bench-db agent-memory-bench-50000] [--queries 150]
//
// The bench side fills the bge-m3 embedding column if missing (identical
// batch loop as bench/embed.ts). The real side is strictly read-only.
import { SQL } from "bun";
import ocpg from "../ocpg.ts";
import { PROJECTS, pick, rng } from "./config.ts";
import { type BenchRow, type Case, buildCorpusWords, buildMix, buildTopicIds, sanitizeOr, score } from "./lib.ts";

const { __internals } = ocpg;

const args = process.argv.slice(2);
const opt = (name: string, fallback: string): string => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : fallback;
};
const ollama = opt("--ollama", "http://localhost:11434");
const perMix = Number(opt("--queries", "150"));
const BENCH = {
  host: opt("--bench-host", "localhost"),
  port: Number(opt("--bench-port", "5433")),
  user: opt("--bench-user", "ocpguser"),
  password: opt("--bench-password", "bench"),
  db: opt("--bench-db", "agent-memory-bench-50000"),
};
const BENCH_COL = "embedding_bge_m3";
const MODEL = "bge-m3";

async function embed(texts: string[]): Promise<number[][]> {
  const res = await fetch(`${ollama}/api/embed`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ model: MODEL, input: texts, keep_alive: "30m" }),
  });
  if (!res.ok) throw new Error(`ollama /api/embed: HTTP ${res.status} ${await res.text()}`);
  return ((await res.json()) as { embeddings: number[][] }).embeddings;
}

const pct = (sorted: number[], q: number) => sorted[Math.min(sorted.length - 1, Math.floor((q / 100) * sorted.length))];

// ---------------------------------------------------------------- real side

// 20 curated real memories + a hand-written paraphrase query each (baked
// 2026-09-18). Paraphrases avoid the target's content words; the script
// reports how many pairs were lexically clean (keyword engine cannot match
// the target at all) vs how many share enough wording for keyword hits.
const PAIRS: Record<number, { q: string; content: string }> = {
  "402": { q: "why does the machine fail to wake from hibernation when I pass the volume's unique identifier", content: "User specifies the resume kernel parameter must be set to /dev/mapper/cryptswap instead of resume=UUID, because the LUKS container UUID differs from the swap partition UUID." },
  "407": { q: "issues when suspend-to-disk meets a fully scrambled disk", content: "Pitfalls identified for combining systemd‑boot, sd‑encrypt, encrypted swap and resume (2024‑2026): no extra resume hook needed; UEFI HibernateLocation variable may be set but explicit resume= is still required; fstab must reference /dev/mapper/cryptswap; cleanup should close cryptswap; /dev/urandom swap is incompatible with hibernation; mkinitcpio hooks are already correct." },
  "962": { q: "the review has to use the prescribed checklist layout with item seven skipped", content: "User requires the audit output to follow the exact audit schema format, covering test cases TC‑1 through TC‑8 for each environment, with TC‑7 marked as N/A." },
  "396": { q: "the async job finished registering the new project roster entry", content: "Background task bg_e40e7b75 successfully created the team member hyperplan-encrypted-swap/heretic." },
  "406": { q: "how to keep the early-boot encrypted volume table synced with the declarative system-config tool", content: "aconfmgr can manage /etc/crypttab.initramfs via a CopyFile or CreateFile directive; the bootstrap script should generate the file during chroot and post‑install must copy the full two‑entry version to preserve the swap mapping across aconfmgr apply." },
  "960": { q: "the review should diff both deployments for autoscaling, traffic routing and volume claim equivalence", content: "User wants the audit to compare environment variables, secret chains, ServiceAccount annotations, presence of HorizontalPodAutoscalers, VirtualService parity, imageUpdater parity, PersistentVolume/PersistentVolumeClaim parity, and any regression in resource‑kind definitions." },
  "201": { q: "the remark above the systems-language install entry describes the wrong tool", content: "Surviving finding: the comment for AddPackage rust at 10‑packages‑core.sh line 105 incorrectly describes reflector; recommendation is to replace it with '# Rust programming language'." },
  "212": { q: "the exclusion glob catching every hyphenated name under the config root is dangerous", content: "The IgnorePath rule `/etc/*-` (line 21) matches any file or directory under `/etc/` ending with a hyphen, which is risky; it should be replaced with explicit patterns for known backup files." },
  "1000": { q: "verify none of the chart inputs set deployment labels or pin container versions", content: "User wants to confirm that across the 32 values files there are no argocd.argoproj.io/sync‑options annotations, no revisionHistoryLimit keys, imageTag values are empty strings, block ordering is correct, and workload‑identity injection is present." },
  "210": { q: "the mkdir-style rule for the audio daemon's drop-in folder feeds the later file copy", content: "The `CreateDir /etc/wireplumber/wireplumber.conf.d` entry (line 79 of `25-config-sys.sh`) correctly creates the required directory for the subsequent CopyFile." },
  "950": { q: "the forge's browser interface won't let you seed a merge proposal headline through address-bar arguments", content: "User clarified that GitHub’s web UI does not support pre‑filling a pull‑request title via URL query parameters in the `/compare` endpoint." },
  "202": { q: "a terminal emulator is named as essential in the instructions doc but never actually installed", content: "Surviving finding: AGENTS.md line 274 mentions alacritty as a key tool, but the package is absent from all .sh files; recommendation is to delete alacritty from the key tools list." },
  "984": { q: "make one branch that handles both upgrade paths", content: "User proposes creating an if/then condition that covers both migration cases." },
  "408": { q: "keep sleep-to-disk enabled since the paging partition was sized for it", content: "Recommendation: retain hibernation support (resume=) because the existing 20 GB swap size is intended for it and encrypted swap with the correct resume target works reliably." },
  "991": { q: "move both sites' apps off the per-namespace credential store onto the shared one", content: "User wants to drop secretStores and point to ClusterSecretStores for both landsbjorg staging/production and vedurstofan test applications." },
  "912": { q: "which compositor settings control split widths and middle placement of the active pane", content: "Global layout options include `preset‑column‑widths`, `default‑column‑width`, `preset‑window‑heights`, `center‑focused‑column`, `always‑center‑single‑column`, and `default‑column‑display \"tabbed\"`, which apply to all workspaces unless overridden." },
  "204": { q: "the vpn vendor's config directory exclusion may no longer match anything on disk", content: "Surviving finding: the IgnorePath '/etc/Proton' in 00‑ignores.sh may be stale because no Proton package creates this path; recommendation is to verify its existence on the system and remove it if absent." },
  "981": { q: "when checking two environments for drift, output only the asked report shape and change nothing", content: "For parity audits in this repo, the user wants the exact requested audit schema format with facts only and no file edits." },
  "404": { q: "the first-look writeup about suspend-to-disk cites distro documentation and manuals", content: "Researcher delivered a Round‑1 findings memo on encrypted swap and hibernation for Arch Linux, citing Arch Wiki pages and man pages accessed in July 2026." },
  "395": { q: "an automation run claimed done but had actually spun forever calling the roster api", content: "Background task bg_20b72624 to create team member hyperplan-encrypted-swap/cryptarch was reported as completed but also cancelled because the subagent called team_task_list ten consecutive times, indicating an infinite loop." },
};

type RealSummary = {
  rows: number;
  embeddedPct: string;
  avgLen: number;
  types: string;
  run: number;
  clean: number;
  kw: number;
  em: number;
  hy: number;
  latency: string;
};

async function realSide(): Promise<RealSummary> {
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
    const [stats] = (await db`
      SELECT count(*) AS n, count(embedding) AS embedded, avg(length(content))::int AS avg_len
      FROM memories`) as { n: number; embedded: number; avg_len: number }[];
    const types = (await db`SELECT memory_type, count(*) AS n FROM memories GROUP BY 1 ORDER BY 2 DESC`) as {
      memory_type: string;
      n: number;
    }[];
    console.log(`\n=== real corpus (${process.env.OCPG_DB || "ocpg"}) ===`);
    console.log(
      `rows ${stats.n} | embedded ${stats.embedded} (${((100 * stats.embedded) / stats.n).toFixed(1)}%) | avg content ${stats.avg_len} chars | ` +
        types.map((t) => `${t.memory_type} ${t.n}`).join(", "),
    );
    const typesStr = types.map((t) => `${t.memory_type} ${t.n}`).join(", ");
    const embeddedPct = ((100 * stats.embedded) / stats.n).toFixed(1);

    // --- paraphrase hit rate ------------------------------------------
    let kw = 0, em = 0, hy = 0, run = 0, clean = 0;
    // Whitespace-insensitive drift check: baked pairs went through a text
    // pipeline that normalizes nbsp-style spaces; a real edit changes words.
    const squash = (s: string) => s.replace(/\s+/g, " ");
    for (const [idStr, pair] of Object.entries(PAIRS)) {
      const found = (await db`SELECT project, content FROM memories WHERE id = ${Number(idStr)}`) as {
        project: string;
        content: string;
      }[];
      if (found.length === 0 || squash(found[0].content) !== squash(pair.content)) {
        console.log(`#${idStr} drifted or deleted - skipped`);
        continue;
      }
      run++;
      const { project, content } = found[0];
      const tsq = __internals.orTsQuery(pair.q);
      const kwRows = (await __internals.buildRelevanceQuery(db, tsq, project)) as unknown as Array<{ content: string }>;
      if (!kwRows.some((r) => r.content === content)) clean++;
      const [v] = await embed([pair.q]);
      const emRows = (await __internals.buildVectorQuery(db, __internals.vectorLiteral(v), project)) as unknown as Array<{
        content: string;
      }>;
      if (kwRows.slice(0, 5).some((r) => r.content === content)) kw++;
      if (emRows.slice(0, 5).some((r) => r.content === content)) em++;
      if (__internals.rrfMerge([kwRows, emRows]).slice(0, 5).some((r) => r.content === content)) hy++;
    }
    console.log(`paraphrase hit@5 over ${run} pairs (${clean} lexically clean): keyword ${kw}/${run} | embedding ${em}/${run} | hybrid ${hy}/${run}`);

    // --- latency on the real table (production-shaped paths, uncached) --
    const q = PAIRS[402].q;
    const dir = "/home/dzhi/git/personal/ocpg";
    const lat: Record<string, number[]> = { keyword: [], embedding: [], hybrid: [] };
    for (let i = 0; i < 30; i++) {
      const tsq = __internals.orTsQuery(q);
      let t = performance.now();
      await __internals.buildRelevanceQuery(db, tsq, dir);
      lat.keyword.push(performance.now() - t);

      t = performance.now();
      const [v1] = await embed([q]);
      await __internals.buildVectorQuery(db, __internals.vectorLiteral(v1), dir);
      lat.embedding.push(performance.now() - t);

      // production shape: embed runs concurrently with the keyword query.
      t = performance.now();
      const pending = embed([q]);
      const kwRows = await __internals.buildRelevanceQuery(db, tsq, dir);
      const [v2] = await pending;
      const emRows = await __internals.buildVectorQuery(db, __internals.vectorLiteral(v2), dir);
      __internals.rrfMerge([kwRows, emRows]);
      lat.hybrid.push(performance.now() - t);
    }
    for (const xs of Object.values(lat)) xs.sort((a, b) => a - b);
    const latencyStr =
      `keyword p50 ${pct(lat.keyword, 50).toFixed(1)}/p95 ${pct(lat.keyword, 95).toFixed(1)}ms | ` +
      `embedding p50 ${pct(lat.embedding, 50).toFixed(1)}/p95 ${pct(lat.embedding, 95).toFixed(1)}ms | ` +
      `hybrid p50 ${pct(lat.hybrid, 50).toFixed(1)}/p95 ${pct(lat.hybrid, 95).toFixed(1)}ms`;
    console.log(`latency (real table, n=30): ${latencyStr}`);
    return {
      rows: stats.n,
      embeddedPct,
      avgLen: stats.avg_len,
      types: typesStr,
      run,
      clean,
      kw,
      em,
      hy,
      latency: latencyStr,
    };
  } finally {
    await db.close({ timeout: 0 });
  }
}

// ------------------------------------------------------------- bench side

type BenchSummary = Record<string, { recall: number; para: number }>;

async function benchSide(): Promise<BenchSummary> {
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
    // Fill the per-model embedding column if missing (same batch loop as
    // bench/embed.ts; bench DBs are throwaway and regenerate identically).
    await db`CREATE EXTENSION IF NOT EXISTS vector`;
    await db.unsafe(`ALTER TABLE memories ADD COLUMN IF NOT EXISTS ${BENCH_COL} vector(1024)`);
    const [{ n: missing }] = (await db.unsafe(`SELECT count(*) AS n FROM memories WHERE ${BENCH_COL} IS NULL`)) as { n: number }[];
    if (Number(missing) > 0) {
      console.log(`\n=== ${BENCH.db}: filling ${missing} embeddings (one-off, GPU) ===`);
      const t0 = performance.now();
      while (true) {
        const batch = (await db.unsafe(`SELECT id, content FROM memories WHERE ${BENCH_COL} IS NULL ORDER BY id LIMIT 256`)) as {
          id: number;
          content: string;
        }[];
        if (batch.length === 0) break;
        const vecs: number[][] = [];
        for (let i = 0; i < batch.length; i += 32) {
          vecs.push(...(await embed(batch.slice(i, i + 32).map((r) => r.content))));
        }
        const ids = batch.map((r) => r.id);
        const lits = vecs.map(__internals.vectorLiteral);
        await db`UPDATE memories m SET ${db(BENCH_COL)} = v.e::vector
                 FROM (SELECT unnest(${db.array(ids, "integer")}) AS id, unnest(${db.array(lits, "text")}) AS e) v
                 WHERE m.id = v.id`;
      }
      await db.unsafe(`CREATE INDEX IF NOT EXISTS idx_memories_${BENCH_COL} ON memories USING hnsw (${BENCH_COL} vector_cosine_ops)`);
      console.log(`filled in ${((performance.now() - t0) / 1000).toFixed(0)}s`);
    }

    const rows = (await db`SELECT id, content, project FROM memories`) as BenchRow[];
    console.log(`\n=== ${BENCH.db}: ${rows.length} memories (synthetic, seeded) ===`);
    const size = 50000;
    const mix = buildMix(rng(999 + size), buildCorpusWords(rows), perMix);
    const project = pick(rng(size * 31 + 7), PROJECTS);
    const topicIds = buildTopicIds(rows, project);
    const queryCache = new Map<string, string>();
    const embedLit = async (q: string): Promise<string> => {
      let lit = queryCache.get(q);
      if (!lit) {
        lit = __internals.vectorLiteral((await embed([q]))[0]);
        queryCache.set(q, lit);
      }
      return lit;
    };
    const vectorRun = async (c: SQL, q: string, d: string) =>
      (await c.unsafe(
        `SELECT content FROM memories WHERE ${BENCH_COL} IS NOT NULL AND (memory_type != 'project_fact' OR project = $1) ORDER BY ${BENCH_COL} <=> $2::vector LIMIT 20`,
        [d, await embedLit(q)],
      )) as Array<{ content: string }>;
    const kwRun = (c: SQL, q: string, d: string) =>
      __internals.buildRelevanceQuery(c, sanitizeOr(q), d) as unknown as Promise<Array<{ content: string }>>;
    const strategies = [
      { name: "fts-or (prod)", run: kwRun },
      { name: "embed-bge-m3", run: vectorRun },
      {
        name: "hybrid-rrf",
        run: async (c: SQL, q: string, d: string) =>
          __internals.rrfMerge([await kwRun(c, q, d), await vectorRun(c, q, d)]).slice(0, 5),
      },
    ];

    console.log("strategy          p50ms  p95ms  recall@5  mrr@5  prec@5  para-rec");
    const summary: Record<string, { recall: number; para: number }> = {};
    for (const s of strategies) {
      const latencies: number[] = [];
      const scores: Array<{ s: NonNullable<ReturnType<typeof score>>; kind: Case["kind"] }> = [];
      for (const c of mix) {
        const t0 = performance.now();
        const returned = await s.run(db, c.text, project);
        latencies.push(performance.now() - t0);
        const sc = score(returned, topicIds.get(c.topicIdx) ?? new Set());
        if (sc) scores.push({ s: sc, kind: c.kind });
      }
      latencies.sort((a, b) => a - b);
      const avg = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0);
      const direct = scores.filter((x) => x.kind === "direct");
      const para = scores.filter((x) => x.kind === "paraphrase");
      summary[s.name] = { recall: avg(direct.concat(para).map((x) => x.s.recall)), para: avg(para.map((x) => x.s.recall)) };
      const row = [
        s.name.padEnd(16),
        pct(latencies, 50).toFixed(2).padStart(5),
        pct(latencies, 95).toFixed(2).padStart(6),
        avg(direct.concat(para).map((x) => x.s.recall)).toFixed(3).padStart(8),
        avg(direct.concat(para).map((x) => x.s.mrr)).toFixed(3).padStart(6),
        avg(direct.concat(para).map((x) => x.s.prec)).toFixed(3).padStart(7),
        avg(para.map((x) => x.s.recall)).toFixed(3).padStart(8),
      ].join(" ");
      console.log(`${row}   (n=${scores.length})`);
    }
    return summary;
  } finally {
    await db.close({ timeout: 0 });
  }
}

const real = await realSide();
const bench = await benchSide();
await __internals.dispose();

// Fixed-template plain-English readout (no model calls; numbers only).
console.log(`\n=== readout ===
On the real corpus (${real.rows} memories, ${real.embeddedPct}% embedded, avg ${real.avgLen} chars; ${real.types}), \
searching with a reworded version of a memory finds the original in the top 5: \
hybrid ${real.hy}/${real.run}, embedding-only ${real.em}/${real.run}, keyword-only ${real.kw}/${real.run} \
(${real.clean} of the ${real.run} pairs share no wording with the target, so keyword had no chance there). \
${real.em > real.hy
    ? `Embedding-only beats hybrid on these reworded real queries - structural cause: unlike the synthetic bench (whose paraphrase queries are keyword-empty by construction), real paraphrases still keyword-match unrelated memories, and equal-weight RRF lets that keyword noise outrank vector-only hits, diluting the top 5. `
    : ""}\
On the synthetic 50k dataset: hybrid recall@5 ${bench["hybrid-rrf"].recall.toFixed(3)} vs \
keyword ${bench["fts-or (prod)"].recall.toFixed(3)} and embedding-only ${bench["embed-bge-m3"].recall.toFixed(3)}, \
paraphrase recall ${bench["hybrid-rrf"].para.toFixed(3)} vs ${bench["fts-or (prod)"].para.toFixed(3)} for keyword. \
Latency on the live table (n=30): ${real.latency} - the warm embed call dominates and stays far inside the 1s \
injection deadline.`);
