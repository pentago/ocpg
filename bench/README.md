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
from shipped SQL. The other strategies are candidates defined here.

## Metrics

| column   | meaning                                                                  |
| -------- | ------------------------------------------------------------------------ |
| p50/p95  | query latency, whole mix                                                 |
| recall@5 | share of the relevant set present in the top 5 (injection serves LIMIT 5) |
| mrr@5    | 1/rank of the first relevant memory                                       |
| prec@5   | share of the top 5 that is relevant (punishes noisy OR matches)           |
| para-rec | recall@5 on paraphrase queries - the pgvector decision number             |
| bufhit   | shared-buffer hit % from an EXPLAIN (ANALYZE, BUFFERS) sample             |

## Results (2026-09-17, this laptop, 150+75 queries per dataset)

| strategy       | 485 rows            | 5k rows             | 50k rows              |
| -------------- | ------------------- | ------------------- | --------------------- |
| fts-or (prod)  | 0.1ms / rec .70     | 0.4ms / rec .67     | 3.8ms p95 48 / rec .67 |
| fts-and        | 0.05ms / rec .00    | 0.07ms / rec .003   | 0.12ms / rec .017     |
| fts-or-cd      | 0.6ms / rec .70     | 4.4ms / rec .67     | 48ms p95 643 / rec .67 |
| trgm-blend     | 6.0ms / rec .72     | 59ms / rec .67      | 585ms / rec .67       |
| fts-or-recency | 0.1ms / rec .70     | 0.4ms / rec .66     | 4.0ms / rec .67       |
| recency-only   | 0.1ms / rec .07     | 0.4ms / rec .036    | 4.4ms / rec .039      |

Readings:

1. **fts-or (prod) is the right default.** Best accuracy-per-millisecond by a
   wide margin; the whole ranking gap vs the recency baseline (0.67 vs 0.04
   recall) is the value of relevance injection.
2. **AND semantics collapse on multi-word queries** (recall 0.00-0.02): one
   word the memory never uses kills the match. Acted on: `memory_recall` now
   uses the same OR-of-stemmed-words query as injection.
3. **ts_rank_cd and trgm-blend are dead ends**: same or negligible accuracy
   for 10x-150x the latency at 50k rows.
4. **Recency prior adds nothing** to relevance ranking (fts-or-recency ≈
   fts-or) - relevance already dominates; drop that idea.
5. **Paraphrase recall is 0.000 at every size**: lexical search finds nothing
   under pure synonym swap. This is the standing pgvector case - revisit when
   real-world paraphrase misses show up; the prod query shape stays, only the
   scoring would change.
