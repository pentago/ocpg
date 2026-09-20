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

## QQP stress test (2026-09-20, `bun bench/qqp-consolidate.ts`, Quora Question Pairs)

The 0.83 threshold and the `isTemplatedAutoLog` exclusion filter were both
calibrated on small, hand-built sets (26 pairs; 32 real corpus candidates).
This test throws real scale at the same question: a balanced 5,000-pair
sample (2,500 duplicate / 2,500 distinct) from Quora Question Pairs (QQP,
`nyu-mll/glue`'s `qqp` config on Hugging Face - public parquet, no Kaggle
login; Quora's own license note is "subject to Quora's Terms of Service,
allowing for non-commercial use", which this local, non-redistributed
benchmark satisfies), run through the exact production pipeline
(`__internals.embed`, bge-m3) against a scratch DB (`qqp-consolidate-bench`,
schema mirrors `deploy/init/01-init.sh`, dropped after use, never
`agent-memory-bench-*` or the real DB). `bench/qqp-prepare.py` (one-off,
needs `duckdb` in a throwaway Python venv - not a project dependency) turns
the parquet into `bench/data/qqp-sample.ndjson` (gitignored, regenerate
rather than commit).

Calibration table (same shape as the 26-pair table above):

| category  | min   | max   | mean  | n    |
| --------- | ----- | ----- | ----- | ---- |
| duplicate | 0.629 | 1.000 | 0.899 | 2500 |
| distinct  | 0.160 | 0.999 | 0.663 | 2500 |

Unlike the 26-pair set (distinct max 0.760, duplicate min 0.784 - a real
gap), QQP's ranges overlap almost completely. Full threshold sweep:

| threshold | precision | recall | FPR   |
| --------- | --------- | ------ | ----- |
| 0.70      | 0.676     | 0.988  | 0.474 |
| 0.75      | 0.722     | 0.959  | 0.370 |
| 0.80      | 0.766     | 0.880  | 0.268 |
| **0.83**  | **0.804** | **0.822** | **0.200** |
| 0.86      | 0.837     | 0.726  | 0.142 |
| 0.90      | 0.892     | 0.553  | 0.067 |
| 0.93      | 0.916     | 0.401  | 0.037 |
| 0.95      | 0.942     | 0.301  | 0.018 |
| 0.97      | 0.961     | 0.189  | 0.008 |
| 0.99      | 0.978     | 0.072  | 0.002 |

Readings:

1. **0.83 does not sit in a safe margin at QQP's scale** - 20% of genuinely
   distinct pairs are flagged (vs 0/10 on the 26-pair set). The curve has no
   knee: FPR falls off smoothly all the way to 0.99, where it finally
   reaches the 26-pair set's near-zero level, but at the cost of recall
   collapsing to 0.072. Every threshold in between is a smooth trade, not a
   stable region - the 26-pair set's clean separation does not reproduce at
   real scale.
2. **Manual inspection of the false positives splits into two causes, not
   one.** Sampling the highest-cosine "distinct" pairs (0.98-0.999) shows
   QQP label noise, not embedding error - e.g. "How do I get rid of
   stuttering?" / "How can I get rid of stuttering?" is labeled
   not-duplicate at cosine 0.999. This is a documented property of QQP
   (crowdsourced labels, acknowledged annotator subjectivity), not a defect
   in the pipeline being tested. Sampling pairs right at 0.83-0.85 shows the
   *other* failure mode instead - genuinely different questions that merely
   share topic and phrasing ("What are some ways to calculate moles?" /
   "How do you calculate the moles of acid?", "What does hematology test
   for?" / "What is hematology?") - the same "distinct-but-related" case the
   26-pair set already worried about, just at a false-positive rate the
   26-pair set was too small to reveal.
3. **A scoping caveat, not a rebuttal**: QQP pairs are all
   Quora-style questions ("How do I...", "What is...") on a handful of
   recurring topics (health, relationships, careers, tech), so shared
   question phrasing alone likely inflates cosine similarity between
   unrelated QQP pairs in a way that may not transfer to ocpg's real corpus,
   where distinct memories are typically about unrelated subjects entirely,
   not the same subject phrased as a question two different ways. QQP is
   still the more honest stress test of "does the embedding model conflate
   near-paraphrase with true duplication" - it just does not prove the
   corpus-level false-merge rate would be 20% in production.
4. **Exclusion filter negative control passes cleanly**: `isTemplatedAutoLog`
   fired on 0/10,000 QQP rows. It stays narrowly targeted at ocpg's own
   auto-generated content shapes and does not accidentally suppress
   ordinary natural-language duplicate detection.

Decision (per the spec, this is a recommendation, not a threshold change):
0.83 is real production experience validated against 26 pairs and a live
corpus audit, both showing zero false merges on the failure mode that
matters; QQP shows that guarantee does not extend to arbitrary natural
language at scale, with the caveat in reading 3 that QQP's own genre may
overstate the real-corpus risk. Any change to `CONSOLIDATE_EMBED_THRESHOLD`
is an explicit follow-up, not part of this result.

## Detail cross-check for the meaning pass (2026-09-20, same `bun bench/qqp-consolidate.ts` run, re-scored)

Spec: "detail cross-check for consolidation's meaning pass" - the QQP stress
test above showed no threshold safely separates duplicate from distinct at
scale. This adds a second, independent, regex-only signal
(`extractDetails`/`detailConflicts` in `ocpg.ts`): a candidate pair (cosine
>= 0.83, same as today) only auto-merges if its extracted numbers, paths, and
capitalized names either agree or are absent on at least one side. A
conflicting pair is NOT merged - it is reported as `[meaning-uncertain]`
instead, for the calling agent to resolve via `memory_update` or leave alone.
No model call, no change to `CONSOLIDATE_EMBED_THRESHOLD` itself.

Re-scoring the same 5,000-pair QQP sample's 2,555 threshold-candidates
(2,054 true duplicate / 501 distinct) through the detail check:

| outcome                          | TP   | FP  |
| --------------------------------- | ---- | --- |
| clean (auto-merged, same as today) | 2010 | 481 |
| `[meaning-uncertain]` (blocked, flagged for review) | 44 | 20 |

| metric                                | before | after |
| -------------------------------------- | ------ | ----- |
| precision (of what's auto-merged)      | 0.804  | 0.807 |
| recall (auto-merged, silent)           | 0.822  | 0.804 |
| recall (auto-merged + flagged review)  | 0.822  | 0.822 |
| FPR (of what's auto-merged)            | 0.200  | 0.192 |

Readings:

1. **On QQP specifically, the effect is small**: FPR drops from 0.200 to
   0.192 (20/501 false positives, 4.0%, correctly rerouted to
   `[meaning-uncertain]`), and 44/2054 true duplicates (2.1%) are now
   blocked from silent auto-merge and routed to review instead - a small,
   explicit, reviewable cost, not a silent loss. The `[meaning-uncertain]`
   bucket is 64 pairs, 1.3% of all scored pairs - small enough to review.
2. **This is the expected result given QQP's own genre, not a failed
   check.** The QQP stress test's own scoping caveat (reading 3, above)
   applies again here even more directly: QQP false positives are
   near-duplicate *questions* on the same handful of topics ("What are some
   ways to calculate moles?" / "How do you calculate the moles of acid?"),
   which mostly share no numbers, paths, or proper nouns to conflict on in
   the first place - there is nothing for this check to catch. The concrete
   failure mode this check targets (a rate limit changing from 100 to 500
   requests/minute, a `/etc/systemd/system/` vs `~/.config/systemd/user/`
   path) is a shape ocpg's own real memory corpus produces far more often
   than QQP's question pairs do - version numbers, ports, file paths, tool
   names. Both spec examples were verified directly against bge-m3
   (`tests/ocpg.test.ts`, "consolidate: [meaning-uncertain] bucket"): cosine
   ~0.898 and ~0.930 respectively, both above 0.83, both now routed to
   `[meaning-uncertain]` instead of silently merged.
3. **Ship gate met on the terms the spec set**: no large new false-negative
   cost (2.1% of true positives, explicit and reviewable, not silent), and
   the uncertain bucket stays small. The spec's target FPR drop was
   explicitly left as "a judgment call once real data is in, not fixed in
   advance" - on QQP the drop is small for the genre-scoping reason above;
   the check is expected to do more work on ocpg's own real corpus, which
   has far more numbers/paths/names per memory than a Quora question does.

## Detail cross-check re-test on ocpg-shaped content (2026-09-20, `bun bench/ocpg-shaped-consolidate.ts`)

Follow-up spec: the QQP result above is real but QQP itself can't test the
hypothesis cleanly - Quora questions rarely contain numbers, paths, or
proper nouns, so most QQP pairs simply have nothing for the detail check to
catch. This bench builds a labeled corpus that DOES look like ocpg's real
content: 808 pairs (368 duplicate / 440 distinct) generated in-process from
the same 40-topic infra vocabulary `bench/generate.ts` already uses
(postgres, systemd, wireguard, terraform, ...), across 12 categories:

- `duplicate` (309 candidates at threshold) - same fact, reworded, injected
  number/path/name value UNCHANGED.
- `update-<shape>` (7 shapes: rate-limit, port, retry-count, system-vs-user
  unit path, config-location, env-values-file, alert-routing/dependency-bot/
  ci-provider tool names) - same shape, injected value CHANGED - a
  genuinely different fact, exactly the two real incidents' shape (rate
  limit 100->500; `/etc/systemd/system/` vs `~/.config/systemd/user/`).
- `distinct-related` - same topic, different aspect, general templates (the
  "topically related but different fact" class QQP also showed).
- `fn-stress` (8 hand-picked pairs) - genuine near-duplicates where a
  number/path/name differs only in formatting (comma grouping, trailing
  zero, trailing slash, letter case, leading zero) or is spelled out on one
  side - stress-tests whether the check introduces new false negatives.

Calibration (same shape as the QQP table): duplicate 0.787-0.997 (mean
.902), distinct 0.498-0.936 (mean .794) - a real gap exists but the ranges
still overlap around 0.83, same qualitative shape as QQP, not the 26-pair
set's clean separation.

Threshold sweep (before the detail check) - baseline FPR at 0.83 is
**worse** than QQP's (0.370 vs 0.200), because this corpus is deliberately
built with pairs in the exact shape that fools cosine similarity (same
sentence, one specific value swapped):

| threshold | precision | recall | FPR   |
| --------- | --------- | ------ | ----- |
| 0.75      | 0.544     | 1.000  | 0.700 |
| 0.80      | 0.622     | 0.984  | 0.500 |
| **0.83**  | **0.660** | **0.859** | **0.370** |
| 0.86      | 0.673     | 0.783  | 0.318 |
| 0.90      | 0.679     | 0.679  | 0.268 |

Detail cross-check applied on top of the shipped threshold - 479 candidates
(316 true duplicate / 163 distinct):

| outcome                                              | TP  | FP  |
| ----------------------------------------------------- | --- | --- |
| clean (auto-merged, same as today)                     | 311 | 2   |
| `[meaning-uncertain]` (blocked, flagged for review)    | 5   | 161 |

| metric                                | before | after |
| -------------------------------------- | ------ | ----- |
| precision (of what's auto-merged)      | 0.660  | 0.994 |
| recall (auto-merged, silent)           | 0.859  | 0.845 |
| recall (auto-merged + flagged review)  | 0.859  | 0.859 |
| FPR (of what's auto-merged)            | 0.370  | 0.005 |

Per-category breakdown (candidates only):

| category                  | candidates | clean | uncertain |
| -------------------------- | ---------- | ----- | --------- |
| duplicate                   | 309        | 309   | 0         |
| distinct-related             | 2          | 2     | 0         |
| fn-stress                   | 7          | 2     | 5         |
| update-rate-limit           | 40         | 0     | 40        |
| update-system-vs-user-unit  | 40         | 0     | 40        |
| update-config-location       | 40         | 0     | 40        |
| update-env-values-file       | 40         | 0     | 40        |
| update-ci-provider           | 1          | 0     | 1         |
| update-port / update-retry-count / update-alert-routing / update-dependency-bot | 0 | - | - (never reached cosine 0.83 as a pair in the first place) |

Readings:

1. **This confirms the "corpus mismatch" explanation, decisively.**
   161/163 false positives (98.8%) are correctly rerouted to
   `[meaning-uncertain]` instead of silently merged; FPR of what's actually
   auto-merged drops from 0.370 to 0.005 - near elimination, not a marginal
   improvement. The `update-*` categories (the exact shape of both real
   incidents) are caught at effectively 100% wherever they reached the
   similarity threshold at all (0 clean merges in any `update-*` row) - the
   check does exactly what it was designed to do once the corpus actually
   contains the failure mode.
2. **The false-negative cost stays small and explicit**: 5/316 true
   duplicates (1.6%) are now routed to review instead of silently merged -
   lower than QQP's 2.1%, still small. Per-pair `fn-stress` detail: comma
   grouping (`1,000` vs `1000`), a dropped trailing zero (`2.5.0` vs `2.5`),
   a trailing slash (`/var/log/app` vs `/var/log/app/`), letter case
   (`Jira` vs `JIRA`), and a leading zero (`02:00` vs `2:00`) all get
   blocked - a real, honestly-documented gap in a regex-only check (no
   number/path/name normalization), consistent with `extractDetails`'
   comment that this component is the most likely to need iteration. Two
   `fn-stress` pairs merge cleanly by design: a spelled-out number ("three
   replicas") produces no conflict because one side has nothing to conflict
   with (absence rule), and a unit-suffix number (`300 seconds` vs `300s`)
   extracts the identical token on both sides. The spec's own ambiguous
   example ("meeting moved from 3pm to 4pm" vs "the meeting is now at 4pm")
   also merges cleanly here - not because the check is lenient about the
   change, but because the first sentence mentions BOTH times, so its
   number set `{3,4}` overlaps the second sentence's `{4}` and the overlap
   rule (not disjoint) waves it through; a version phrased as two isolated,
   non-overlapping mentions would conflict like the other five.
3. **`[meaning-uncertain]` bucket size (20.5% of all scored pairs) looks
   large only because this corpus is adversarially dense with the exact
   failure mode** (every `update-*` pair exists specifically to trigger it)
   - it is not representative of a real memory corpus's overall duplicate
   rate, only of how well the check performs when the failure mode is
   actually present. The QQP bench's 1.3% bucket size is the more
   representative "ambient" rate for ordinary content.
4. **Overturns nothing** - the "does the extraction actually work" concern
   the spec raised is answered: it does, decisively, on content shaped like
   ocpg's own memories. The QQP result was a corpus mismatch, not a weak
   fix.

Reproducible via `bun bench/ocpg-shaped-consolidate.ts` (no external
dataset - the corpus is generated in-process; needs a reachable Ollama and
a `CREATEDB`-capable `OCPG_*` user, same as the other consolidate benches).

## Cross-session recall signal (2026-09-20, `bun bench/cross-session.ts`, 485/4970/49980-row bench DBs)

Spec: replace the dormant `access_count` (bumped on every recall, unused by
ranking since a prior rich-get-richer revert) with a new `memory_recalls`
table keyed `(memory_id, session_id)` - `COUNT(DISTINCT session_id)` is the
signal, not raw exposure, because the PRIMARY KEY makes repeat recalls
within one session count once. Proposed ORDER BY addition:
`LEAST(cross_session_count, 5) * 0.002` (capped, weighted well below the
existing same-project boost of 0.01).

Benched against `buildRelevanceQuery`'s existing query mix, with a simulated
reuse history (15% of each topic's memories recalled from 2-5 distinct fake
sessions, the rest cold - the same starting point every real memory has
today):

| dataset | metric | baseline | + xsess tiebreak |
| ------- | ------ | -------- | ----------------- |
| 485 rows (n=346) | recall / mrr / prec | .318 / .334 / .293 | .318 / **.336** / .293 |
| 4970 rows (n=357) | recall / mrr / prec | .396 / .399 / .396 | .396 / **.401** / .396 |
| 49980 rows (n=372) | recall / mrr / prec | .376 / .376 / .376 | .376 / **.379** / .376 |

Recall and precision are unchanged at all three sizes (identical to 3
decimals); MRR improves slightly and consistently (+0.002 to +0.003) - the
tiebreak nudges genuinely-reused memories very slightly higher without
touching which rows qualify or displacing anything, exactly the "small
tiebreak, not a ranking replacement" role the spec asked for.

The failure this replaces `access_count` because of: spam-recalling one
memory 50x from a SINGLE session must not move its rank, only genuinely
distinct sessions may. Verified directly (not just argued) at all three
sizes - a virgin, mid-ranked row's first recall (a real 0->1 signal) is
allowed to move its rank; 49 additional recalls from that SAME session then
leave both `cross_session_count` and rank exactly where the first recall put
them, while 5 more recalls from genuinely distinct sessions move it further
(bounded by the cap):

```
memory #289 (485 rows):  virgin rank 3 -> first recall rank 0 -> 49 more same-session recalls: rank 0 (unchanged)
                         -> 5 distinct-session recalls: rank 0 (already best, cap has no further room to show)
memory #236 (4970 rows): virgin rank 1 -> first recall rank 1 -> 49 more same-session recalls: rank 1 (unchanged)
                         -> 5 distinct-session recalls: rank 0
memory #30 (49980 rows): virgin rank 6 -> first recall rank 4 -> 49 more same-session recalls: rank 4 (unchanged)
                         -> 5 distinct-session recalls: rank 0
```

Shipped: `crossSessionJoin`/`crossSessionBoost` in `ocpg.ts`, added to
`buildRelevanceQuery`'s ORDER BY and `recall()`'s directed-query ORDER BY;
the `memory_recalls` table is a new additive migration
(`deploy/init/01-init.sh`, `deploy/README.md`'s upgrade block,
`bench/generate.ts`'s DDL). `access_count`/`last_accessed_at` are untouched -
still bumped on every recall, still unused by ranking, kept only as data
that might back a future "never recalled" cleanup signal.
