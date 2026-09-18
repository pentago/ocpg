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

### Thesaurus strategies (setup)

`fts-or-thesaurus` / `fts-phrase-thes` query through a thesaurus text search
config built from the bench's own `PARAPHRASES` map - the missing dimension in
every other candidate, which differ only in ranking/scoring, not vocabulary.

Setup (one-time per Postgres server; restart of the *container* loses it):

```bash
bun bench:thesaurus                                            # regenerate the .ths from PARAPHRASES
# system install: copy into /usr/share/postgresql/<version>/tsearch_data/
docker cp bench/thesaurus/bench_synonyms.ths <pg-container>:/usr/local/share/postgresql/tsearch_data/
bun bench:generate --sizes 500,5000                            # CREATE TEXT SEARCH DICTIONARY ... per bench DB
```

`generate.ts` installs the dictionary into each bench DB it creates; a server
without the `.ths` file still generates fine and `run.ts` skips the thesaurus
strategies with a notice. The `.ths` file is generated from `PARAPHRASES` and
checked in; `run.ts` fails the whole bench when it drifts from the map.
Dictionary rules are query-time only - `search_vector` stays
`to_tsvector('english')`, so the same column and GIN index serve every
strategy.

`fts-or-thesaurus` keeps the OR shape (direct queries must match
`fts-or (prod)`) but to_tsquery OR operands are single tokens, so multi-word
thesaurus rules cannot fire there; `fts-phrase-thes` uses `plainto_tsquery`,
whose adjacent tokens let multi-word rules fire - at the cost of AND
semantics on direct queries. Read the para-rec columns of both together.

`fts-or (prod)` executes the **exact production injection query**, imported
from ocpg's `__internals` - the refactor exists so the harness cannot drift
from shipped SQL. The other strategies are candidates defined here.

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

### Thesaurus results (2026-09-17, ephemeral postgres:18-alpine, thesaurus from PARAPHRASES)

| strategy          | 485 rows            | 5k rows             |
| ----------------- | ------------------- | ------------------- |
| fts-or (prod)     | rec .29 / para .000 | rec .43 / para .000 |
| fts-or-thesaurus  | rec .29 / para .000 | rec .44 / para .05  |
| fts-phrase-thes   | rec .11 / para .32  | rec .19 / para .60  |

### Combined-shape results (2026-09-17, ephemeral postgres:18-alpine, thesaurus from PARAPHRASES)

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
in, and fixing it is out of scope. Verdict: **go** - this is the strategy
for a follow-up production spec (dictionary shipping in `deploy/init/` +
migration path).

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
3. **The bounded thesaurus still beats the general embedder on paraphrase**
   (.60 vs .295 at 5k) - but it only covers its own synonym list, while
   bge-m3 generalizes to paraphrases nobody wrote down. Which matters more
   depends on how real-world phrasing drifts; today the thesaurus direction
   (fts-or-plus-thesaurus) remains the better production candidate.
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
recall - never worse than either, which is why the production hybrid ships
this shape. Latency note: the bench's shared query-embedding cache hides the
ollama call in this row; the production cost is one ~20ms warm embed
overlapped with the keyword query plus a sub-ms merge. A cold bge-m3 load is
~2-3s (over the 1s injection deadline), so the plugin warms the model at
session start and pins it with `keep_alive`.
