# Retrieval benchmark

Objective comparison of memory-retrieval strategies on synthetic databases
with **known relevance ground truth** - because accuracy is only measurable
when, for every query, the right answer set is known by construction.

## How the ground truth works

The generator (`generate.ts`) fills `agent-memory-bench-<size>` databases
(dedicated DBs, never the real one) with memories built from 40 topic
vocabularies. For a query built from a topic's words, the relevant set is
"that topic's memories" - recall/precision/MRR fall out directly. Purely
random data could only ever measure speed.

Two query mixes:

- **direct** - words sampled from the target topic's actual corpus
  vocabulary (all present in the corpus by construction).
- **paraphrase** - synonyms that appear **nowhere** in the corpus (the
  mapping is leak-checked against the generated data; a leaking word would
  silently understate the gap). Paraphrase recall is the honest number for
  "would embeddings help?" - zero means lexical search has nothing to grab.

Reproducible: datasets are seeded (`--seed`, default 42), so every strategy
is scored against identical data.

## Run

```bash
bun bench/generate.ts --sizes 500,5000,50000   # (re)creates the bench DBs
bun bench/run.ts --sizes 500,5000 --queries 150
bun bench/run.ts --skip-explain                # skip the EXPLAIN sample
```

Requires the `OCPG_*` env user to hold CREATEDB. Bench DBs are
`agent-memory-bench-<size>`; delete them anytime with plain
`DROP DATABASE` (or regenerate - it drops first).

`fts-or (prod)` executes the **exact production injection query**, imported
from ocpg's `__internals` - the refactor exists so the harness cannot drift
from shipped SQL. The other strategies in `run.ts` are candidates.

### Embedding strategies (pgvector + local Ollama)

`bench/embed.ts` tests the pgvector question directly: same datasets, same
seeds, same query mix and scoring as `run.ts` (shared code in `bench/lib.ts`),
with strategies `embed-<model>` (cosine over HNSW), `embed-minilm`, plus the
`fts-or (prod)` and `recency-only` anchors for a side-by-side table.

Setup: a throwaway pgvector container (**never** the real agent-memory DB) and
the **host** ollama (GPU). A containerized ollama is CPU-only here (no
nvidia-container-toolkit), which makes 50k-row embedding take hours.

```bash
docker compose -f bench/compose.yaml up -d                     # 127.0.0.1:5433
ollama pull all-minilm && ollama pull bge-m3                   # host ollama
OCPG_USER=ocpguser OCPG_PORT=5433 OCPG_PASSWORD=bench bun bench/generate.ts --sizes 500,5000,50000
bun run bench:embed                                            # = same env + bench/embed.ts
```

Notes:

- `embed.ts` needs the full `OCPG_USER/PORT/PASSWORD` override - a direnv
  `.envrc` exporting the real DB's `OCPG_*` would otherwise silently point the
  bench at the production server (the bench DB names don't exist there, but
  `generate.ts` drops/creates and would happily do it on the wrong server).
- Embedding columns are per model (`embedding_bge_m3`, ...); the legacy
  MiniLM column `embedding` (384-dim) is reused only if it verifies against
  the host ollama's `all-minilm` (cosine >= 0.999 on samples), otherwise it is
  re-embedded so both sides of the table share one embedding pipeline.
- Embed-strategy latency includes the ollama HTTP call (honest for the
  production question); query embeddings are cached per unique query text,
  mirroring the injection cache.
- Model is selectable via `--model` (default `bge-m3`, 1024 dims). Keep dims
  <= 2000 or HNSW can't index the column.

## Metrics

| column   | meaning                                                                  |
| -------- | ------------------------------------------------------------------------ |
| p50/p95  | query latency, whole mix                                                 |
| recall@5 | share of the relevant set present in the top 5 (injection serves LIMIT 5) |
| mrr@5    | 1/rank of the first relevant memory                                       |
| prec@5   | share of the top 5 that is relevant (punishes noisy OR matches)           |
| para-rec | recall@5 on paraphrase queries - the pgvector decision number             |
| bufhit   | shared-buffer hit % from an EXPLAIN (ANALYZE, BUFFERS) sample             |

Ground truth is per calling project: bench rows are all `project_fact`, and
every strategy carries the same visibility predicate
(`memory_type != 'project_fact' OR project = <dir>`), so only the calling
project's rows of a topic can be returned - cross-project rows are not
reachable answers and don't count against recall. Absolute recall is
therefore lower than a naive global-corpus reading; the numbers compare
strategies against each other on identical visibility.

## Results (2026-09-17, stack_fact visibility, this laptop, 100+50 queries per dataset)

| strategy       | 485 rows            | 5k rows             |
| -------------- | ------------------- | ------------------- |
| fts-or (prod)  | 0.07ms / rec .26    | 0.09ms p95 1.4 / rec .37 |
| fts-and        | 0.03ms / rec .00    | 0.07ms / rec .00    |
| fts-or-cd      | 0.05ms / rec .26    | 0.12ms p95 14 / rec .36 |
| trgm-blend     | 1.2ms / rec .27     | 12ms / rec .38      |
| fts-or-recency | 0.04ms / rec .26    | 0.07ms / rec .37    |
| recency-only   | 0.11ms / rec .20    | 0.7ms / rec .06     |

### Thesaurus results (2026-09-17, ephemeral postgres:18-alpine, thesaurus from PARAPHRASES) - SUPERSEDED 2026-09-18, bench code removed 2026-09-19

A bounded thesaurus (rules generated from `PARAPHRASES`) was explored as an
alternative to vector search for closing the paraphrase gap, before the
embedding results below made the case for hybrid retrieval instead. Hybrid
(FTS + bge-m3 embeddings via `hybridMerge`) is what shipped in `ocpg.ts` -
none of the thesaurus strategies (`fts-or-thesaurus`, `fts-phrase-thes`,
`fts-or-plus-thesaurus`) or their harness code (`bench/generate-thesaurus.ts`,
`bench/thesaurus/`, the thesaurus DDL in `generate.ts`, the strategies in
`run.ts`) exist in the repo anymore. Kept below as a historical record of
what was tried and why it looked promising at the time.

| strategy          | 485 rows            | 5k rows             |
| ----------------- | ------------------- | ------------------- |
| fts-or (prod)     | rec .29 / para .000 | rec .43 / para .000 |
| fts-or-thesaurus  | rec .29 / para .000 | rec .44 / para .05  |
| fts-phrase-thes   | rec .11 / para .32  | rec .19 / para .60  |

### Combined-shape results (2026-09-17, ephemeral postgres:18-alpine, thesaurus from PARAPHRASES) - SUPERSEDED, see above

| strategy                 | 485 rows            | 5k rows             |
| ------------------------ | ------------------- | ------------------- |
| fts-or (prod)            | rec .29 / para .000 | rec .43 / para .000 |
| fts-or-thesaurus         | rec .29 / para .000 | rec .44 / para .05  |
| fts-phrase-thes          | rec .11 / para .32  | rec .19 / para .60  |
| fts-or-plus-thesaurus    | rec .41 / para .32  | rec .62 / para .60  |

`fts-or-plus-thesaurus` = `WHERE or_match OR phrase_thes_match`, ranked by
`GREATEST(ts_rank(or), ts_rank(phrase))`. Direct-only recall (split out from
the para mix, which the table's rec column folds in) is unchanged vs prod:
.655 vs .658 at 485, .567 at 5k - the OR half of the WHERE is byte-identical
to prod's and the GREATEST ranking does not displace prod's hits. Para-rec
equals `fts-phrase-thes` at both sizes; prec@5 improves rather than collapses
(.37/.62 vs prod's .26/.43) because the thesaurus side pulls in *relevant*
rows. Latency p50 1.33ms / p95 1.84ms at 5k (prod 1.16/1.74) - the OR of two
`@@` conditions costs ~15%, far inside the injection budget; bufhit stays
100% (no seq-scan collapse). The hyphenated-paraphrase gap ("in-memory
store") persists unchanged - it lives in the phrase half this shape unions
in, and fixing it is out of scope. Verdict at the time: **go** - proposed as
the strategy for a follow-up production spec (dictionary shipping in
`deploy/init/` + migration path). This was **not** what shipped: the
embedding/hybrid results below won out instead, and the thesaurus follow-up
spec was never written.

Readings:

1. **A thesaurus from PARAPHRASES recovers most paraphrase recall**: 0.000
   → 0.60 para-rec at 5k (`fts-phrase-thes`, `plainto_tsquery`), at roughly
   half prod's latency (AND semantics match fewer rows; not a like-for-like
   speed win). Vector search is not needed while the real-world paraphrase
   drift matches a bounded synonym list.
2. **OR-shaped queries cannot fire multi-word rules**: to_tsquery operands are
   single tokens, so `fts-or-thesaurus` only catches single-word pairs
   (para-rec .05 at 5k). Direct scores are identical to prod - the fallback
   chain rewiring is safe - but the OR shape is not where the value is.
3. **The phrase variant's direct-recall collapse is AND semantics, not the
   thesaurus** (same shape as fts-and). A production design would need to
   combine both shapes (OR terms + phrase-rewritten paraphrases), which is a
   follow-up spec; hyphenated paraphrases ("in-memory store") still do not
   fire and count against the .60.

Readings:

1. **fts-or (prod) is still the right default** - best accuracy-per-millisecond
   by a wide margin; the relevance gap vs the recency baseline (0.37 vs 0.06
   recall at 5k) is the value of relevance injection.
2. **AND semantics collapse on multi-word queries** (recall 0.00): one word
   the memory never uses kills the match. Acted on: `memory_recall` now uses
   the same OR-of-stemmed-words query as injection.
3. **ts_rank_cd and trgm-blend remain dead ends**: comparable accuracy for
   2x-100x the latency.
4. **Paraphrase recall is 0.000 at every size**: lexical search finds nothing
   under pure synonym swap. This is the standing pgvector case - revisit when
   real-world paraphrase misses show up; the prod query shape stays, only the
   scoring would change.

### Embedding results (2026-09-18, pgvector 0.8.6 throwaway container, host ollama on RTX 5070, 150+75 queries per dataset)

| strategy       | 485 rows            | 5k rows             | 50k rows            |
| -------------- | ------------------- | ------------------- | ------------------- |
| embed-bge-m3   | rec .427 / para .336 | rec .555 / para .295 | rec .219 / para .270 |
| embed-minilm   | rec .378 / para .195 | rec .299 / para .057 | rec .219 / para .121 |
| fts-or (prod)  | rec .294 / para .000 | rec .426 / para .000 | rec .364 / para .000 |
| recency-only   | rec .218 / para .227 | rec .079 / para .057 | rec .080 / para .047 |

Latency p50: embed-bge-m3 ~21-26ms at every size (the ollama call dominates;
the HNSW lookup itself is sub-ms at 485/5k, ~2ms at 50k), embed-minilm ~4ms,
fts-or 0.22 / 0.08 / 3.66ms, recency-only 0.11 / 0.81 / 11.95ms.

Readings:

1. **A stronger local model clears the floor at every size** - bge-m3
   paraphrase recall .270 at 50k vs the recency floor .047 (5.7x), .295 vs
   .057 at 5k. The spec's hypothesis holds: MiniLM was the weak link (its
   para-rec is *at* the floor at 5k: .057 vs .057), not the embedding idea
   itself. The old MiniLM run's own numbers were never recorded in the repo,
   and its embedding pipeline could not be reproduced (legacy 384-dim column
   fails cosine >= 0.999 against ollama all-minilm), so the MiniLM side above
   is all-minilm re-embedded through this exact harness - both model columns
   share one pipeline, which is the cleaner comparison anyway.
2. **Embeddings still lose to lexical on direct queries at scale**: at 50k,
   fts-or total recall .364 vs bge-m3 .219 - 40 overlapping-flavor topics in
   near-identical sentence templates blur together in dense space, while
   ts_rank keeps separating on distinctive terms. A production design would be
   hybrid (lexical + vector union), not vector replacement.
3. **The bounded thesaurus still beat the general embedder on paraphrase**
   (.60 vs .295 at 5k) - but it only covered its own synonym list, while
   bge-m3 generalizes to paraphrases nobody wrote down. This reading did not
   hold up as the final call: the hybrid results below (FTS + embeddings)
   beat both, so hybrid shipped instead of the thesaurus direction.
4. **Cost of the vector path**: a live ollama call per injection (~20ms p50
   for bge-m3; the model must stay loaded) plus a per-write embed and a
   re-embed story on model change. fts-or is 0.08-3.7ms of pure Postgres.

### Hybrid results (2026-09-18, same harness; hybrid-rrf = RRF k=60 over the fts-or (prod) and embed-bge-m3 20-row candidate lists)

| strategy       | 485 rows             | 5k rows              | 50k rows             |
| -------------- | -------------------- | -------------------- | -------------------- |
| hybrid-rrf     | rec .474 / para .336 | rec .595 / para .295 | rec .417 / para .270 |
| fts-or (prod)  | rec .294 / para .000 | rec .426 / para .000 | rec .364 / para .000 |
| embed-bge-m3   | rec .427 / para .336 | rec .555 / para .295 | rec .219 / para .270 |

Hybrid recall beats **both** parents at every size (a row present in both
lists is boosted past either list's noise; at 50k it even beats fts-or on the
direct-heavy mix, .417 vs .364) and matches the embedding half on paraphrase
recall - never worse than either on the synthetic mix, which is why the
hybrid shipped. Latency note: the bench's shared query-embedding cache hides
the ollama call in this row; the production cost is one ~20ms warm embed
overlapped with the keyword query plus a sub-ms merge. A cold bge-m3 load is
~2-3s (over the 1s injection deadline), so the plugin warms the model at
session start and pins it with `keep_alive`.

### Merge variants (2026-09-18; real 475-row corpus via bench/report.ts + synthetic 50k)

Plain RRF turned out to dilute vector hits when the keyword half is noisy:
on the real corpus, paraphrase queries still keyword-match unrelated
memories, and equal-weight RRF ties favor keyword-listed rows - real
paraphrase hit@5 was 8/20 for the RRF hybrid vs 14/20 embedding-only (the
synthetic bench cannot show this: its paraphrase words appear nowhere in the
corpus, so its keyword half is empty there by construction). Two fix shapes
benched (`bench/rrf-weights.ts`, `bench/rrf-slots.ts`; candidate lists fetched
once per query, merge varied):

| variant | real hit@5 | syn recall | syn direct | syn para |
| ------- | ---------- | ---------- | ---------- | -------- |
| RRF 1x (initial ship) | 8/20 | .422 | .503 | .242 |
| RRF vector 1.5x/2x/3x | 9/20 | .399 | .469 | .242 |
| reserved R=1 | 11/20 | .422 | .503 | .242 |
| **reserved R=2 (shipped)** | **12/20** | **.422** | **.503** | **.242** |
| reserved R=3 | 13/20 | .413 | .491 | .242 |

Anchors: keyword-only 2/20 real / .364 syn; embedding-only 14/20 / .228.

Weighting fails structurally: rows present in BOTH lists are boosted by both
terms at any weight (rank debugging: an em-rank-1 target needs ~60x to
outrank an em-rank-2 double-dipper - weighting degenerates to
embedding-only). Reserved slots make vector hits unconditional instead.

R=1 recovers less (11/20); R=3 is closest to embedding-only (13/20) but shows
the first synthetic regression (direct .503 -> .491) and lets
nearest-neighbor noise hold a majority (3/5) of the block on no-signal
prompts. R=2 is the knee: half the real gap closed for zero measurable
synthetic cost - shipped as the production merge (`hybridMerge` in ocpg.ts,
injection + recall).

### Backend comparison (2026-09-18, `bun bench/ollama-backends.ts`, live 475-row DB)

Host Ollama on the RTX 5070 vs the containerized CPU-only service
(`deploy/compose.yaml` ollama, 4-CPU/4GB limit, ollama/ollama:0.34.2), same
bge-m3, measured on the paths the plugin actually pays:

| metric | host-gpu | container-cpu |
| ------ | -------- | ------------- |
| cold model load | 2877ms | 1105ms |
| warm single embed p50 / p95 | 20.6 / 29.3ms | 92.9 / 96.7ms |
| 32-text batch (write/backfill shape) | 263ms | 3092ms |
| hybrid path (embed + HNSW query) p50 / p95 | 22.0 / 41.5ms | 94.4 / 98.9ms |

Reading: CPU suffices for daily ocpg use - the warm ~95ms embed fits the
750ms query budget with 7x headroom, and the cold load is actually faster on
CPU (no VRAM transfer; both exceed 750ms, which is why the plugin warms the
model at setup). GPU earns its place only on bulk re-embeds: ~97ms/row CPU vs
~8ms/row GPU at batch-32, i.e. a 50k-row re-embed is ~80min vs ~7min.

## Smart-write judge gate (2026-09-18, `bun bench/judge.ts`, qwen3:4b, live dev DB) - REMOVED 2026-09-19

The judge model (smart writes + compaction capture) was removed entirely:
duplicate detection moved to `memory_consolidate`'s on-demand embedding pass
instead of a model running on every write (see `ocpg.ts`'s `consolidate()`
and `AGENTS.md`). `bench/judge.ts` and `bench/capture.ts` were deleted along
with the feature they tested. The numbers below are kept as a historical
record of what was tried and why it passed its own gate before being
superseded - not as documentation of current behavior.

26 hand-labeled pairs (8 true duplicates, 8 true updates, 10
similar-sounding-but-distinct) run through the production smart-write path
(bge-m3 prefilter, 0.7 cosine threshold, judge verdict). Two consecutive
runs, identical verdicts:

| category | accuracy | misses |
| -------- | -------- | ------ |
| duplicate | 7/8 | 1 judged "update" (merged instead of skipped - redundant, not lossy) |
| update | 7/8 | 1 below the 0.7 prefilter (sim 0.573) - stored as new, consolidate fodder |
| distinct | 10/10 | **0 false-duplicates, 0 false-updates - the hard ship gate** |

Zero-shot prompting FAILED this gate before the few-shot rewrite: the judge
called every restatement "update" and synthesized corrupt merges
("Postgres 1:6", "expires after 2:00 PM"), including one false update that
clobbered a distinct pair. The few-shot prompt in `buildWritePrompt` was the
fix.

The same 26 pairs' bge-m3 cosine similarities (embedding only, no judge) were
re-measured directly when calibrating `CONSOLIDATE_EMBED_THRESHOLD` for the
replacement: duplicates clustered 0.78-0.96 (mean .88), distinct pairs topped
out at 0.76 (mean .58), updates sat in between (0.57-0.87, mean .77) and
overlap both - see `ocpg.ts`'s threshold comment for the resulting pick (0.83).

## Compaction-capture gate (2026-09-18, `bun bench/capture.ts`, 5 real sessions) - REMOVED 2026-09-19

Removed along with the judge model that powered it - there is no
judge-free replacement for "extract durable facts from a transcript".
Keyword-trigger capture is the only automatic capture path that remains.
Kept as a historical record:

Extraction-only rehearsal (no writes) on real opencode sessions, qwen3:4b:

- trivial 2-message session (449 chars): correctly skipped by the 500-char
  floor. Before the floor + stricter prompt it CONFABULATED a preference the
  session never stated - both guards exist because of this.
- 4 substantive sessions: 2-3 facts each, mostly genuine decisions, root
  causes and stated preferences (one matched a preference already in the
  real store verbatim). Residual noise: ~1 in 9 facts is session status
  (SHAs, "next step is tagging") - harmless, `auto`-tagged, purgeable.
- known behavior: overlapping facts inside one batch (e.g. two phrasings of
  the same gotcha) arrive together; in production the smart-write path
  dedups the later one, the capture bench does not exercise writes.

## Consolidate embedding-pass calibration (2026-09-19, ad hoc script against the same 26 pairs, live Ollama bge-m3)

The judge model's removal needed a replacement threshold for
`memory_consolidate`'s new meaning (embedding) pass. Re-measured the exact
26 pairs from the judge gate above directly with bge-m3 cosine (no judge,
no prefilter - just `existing` vs `incoming` similarity):

| category | min | max | mean |
| -------- | --- | --- | ---- |
| duplicate | 0.784 | 0.956 | 0.882 |
| update    | 0.573 | 0.874 | 0.775 |
| distinct  | 0.505 | 0.760 | 0.585 |

No single threshold separates "update" (a fact superseding an older one)
from "duplicate" - the two ranges overlap almost entirely. `distinct` is
the failure mode that matters (accidentally deleting a genuinely unique
fact), and its max (0.760) sits comfortably below duplicate's min (0.784).
`CONSOLIDATE_EMBED_THRESHOLD = 0.83` was picked with margin above the
distinct ceiling (not the bare midpoint, ~0.77, between the two): it
catches 7/8 duplicates and 0/10 distinct pairs (the hard gate), and
2/8 update pairs - deleting the stale side of a superseded fact is an
acceptable, reviewable outcome (the removed text always returns in
`memory_consolidate`'s report), not the lost-unique-fact case this
threshold protects against. Verified end-to-end against the live corpus in
`tests/ocpg.test.ts`'s "consolidate: embedding-based pass" suite.

## Meaning-pass exclusion filter (2026-09-19, real 476-row corpus, first live run)

The threshold above was calibrated on 26 hand-written pairs; the first real
run against the live corpus told a different story. It found 32 candidate
merges - 11 of them wrong, all templated auto-generated content (background-
task status logs from the team/subagent system, session-compaction
summaries, per-app migration checklist entries) where a fixed sentence
template drives cosine similarity high between GENUINELY DIFFERENT facts
(different task ids, team members, sessions, or apps) because only a few
words vary against shared boilerplate. Two exclusion strategies were tested:

| strategy | correct merges affected | wrong merges fixed |
| -------- | ------------------------ | ------------------- |
| exclude `auto_capture` tag | 15/16 (guts the pass) | 8/11 |
| exclude by content pattern (`background task bg_`, `session compacting for project`, `For APP <n> (`) | 0/28 | 9/11 |

The tag carries no signal here - it marks "captured automatically" broadly
(from an earlier, separate capture pipeline predating this project, not
ocpg's own `auto` tag), and sits on both good and bad merges almost
universally. The content pattern is precise because it targets the actual
mechanism (fixed sentence shape), not a proxy for it. Shipped as
`isTemplatedAutoLogPair`/`isTemplatedAutoLog` in `ocpg.ts`.

The remaining 2 wrong merges (natural-language pairs at ~0.84 cosine - e.g.
a system-level vs a user-level systemd unit file, described in structurally
parallel sentences) are NOT templated and were confirmed unfixable by
threshold alone: excluding them by raising the threshold past 0.84 would
also have excluded 3 of the corpus's confirmed-correct merges (0.83-0.87
range). Accepted as a residual, reviewable (not silent) false-merge rate.
