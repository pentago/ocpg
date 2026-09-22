# AGENTS.md

ocpg is a **single-file** OpenCode plugin (`ocpg.ts`): a Postgres-backed persistent memory layer. It registers a `ctx.session.hook("context", ...)` hook (injects memories into system context), a `ctx.session.hook("prompt", ...)` hook (deterministic "remember that..." capture, no LLM), and six tools via `ctx.tool.transform`: `memory_recall`, `memory_remember`, `memory_forget`, `memory_update`, `memory_consolidate`, `memory_tags`. The module exports **only `default`**; test internals are attached via `Object.assign(ocpg, { __internals })` (`import ocpg from "../ocpg"; const { __internals } = ocpg;`).

`README.md` is the user-facing feature doc and is generally kept current - read it first for what each tool does. This file is for things README won't tell you: dev workflow, test setup, and non-obvious implementation traps.

## Commands

```bash
bun install
bun run check      # biome lint
bun run typecheck  # tsc --noEmit
bun test           # tests/ocpg.test.ts - needs a live Postgres, see below
bun run format     # biome format --write . - see formatter note below
```

- `pre-commit install` once per clone. Hooks (`.pre-commit-config.yaml`, `repo: local`/`language: system`) run `biome check .` and `tsc --noEmit` on any commit touching `*.ts`, whole-project (`pass_filenames: false`) - staging `ocpg.ts` without matching `tests/` changes can fail typecheck. A `pre-push` hook (`scripts/check-tag-version.sh`) rejects a tag that doesn't match `package.json`'s version.
- `bun test` is **not** a pre-commit hook (it writes to a real DB); `.github/workflows/check.yml` runs it on `pull_request` only, against a `pgvector/pgvector:0.8.6-pg18-trixie` service container bootstrapped by the real `deploy/init/01-init.sh` (not a copy - schema drift between CI and `deploy/` fails the build).
- Biome's **formatter is disabled** (`biome.json`, `formatter.enabled: false`, `organizeImports: off`) - the source is hand-wrapped and enabling it would reflow the whole file. Only turn it on in a dedicated formatting-only commit, never mixed with logic changes.

## Test prerequisites

- Live Postgres, database with a `memories` table (see `deploy/init/01-init.sh` for the authoritative DDL) plus `pg_trgm` and `vector` extensions. Config is env-only, resolved once at module load - **plugin `"options"` in `opencode.jsonc` are never read**: `OCPG_HOST`/`PORT`/`USER`/`DB`/`SSL`/`PASSWORD`, `OCPG_INJECTION` (`recency` opt-out, default relevance), `OCPG_OLLAMA_HOST` (`localhost`), `OCPG_OLLAMA_PORT` (`11434`), `OCPG_EMBED_MODEL` (default **`embeddinggemma:300m`**, 768-dim `vector` column - not `bge-m3`, an earlier default the code and schema have since moved off).
- Hybrid (embedding) tests probe for a reachable Ollama + the `embedding` column at module load and `test.skipIf` otherwise - CI (no Ollama) proves keyword-only paths; a local DB with Ollama running also exercises the vector/meaning-pass paths.
- Tests seed their own fixture project (`/tmp/ocpg-test-fixture`) and clean every `/tmp/ocpg-test%` project in `afterAll` via a **separate** SQL client - the shared pool is deliberately dead by then (see next bullet).
- **Test order matters**: the last test in the file closes the shared pool (`__internals.sql.close()`) to simulate DB failure. Any DB-touching test added after it will fail - keep new tests earlier in the file, or before that one.
- For manual/exploratory QA, don't touch the live personal DB - spin up a throwaway database (`CREATE DATABASE`, run `deploy/init/01-init.sh` against it, point `OCPG_*` env vars at it before importing `ocpg.ts`) or use `bench/`'s own throwaway-DB scripts.

## Architecture notes (non-obvious from the file alone)

- **Visibility is type-based**, enforced by one predicate (`visibleRows()`, shared by recall, injection, and `memory_tags`): `stack_fact`/`episodic` are global, `project_fact` is visible only from its origin project unless `global: true` is passed. `memory_forget`/`memory_update` reject a foreign project's `project_fact` by name. `superseded_by IS NULL` (`notSuperseded()`) is layered on top for recall/injection/tags, but *not* for forget/update (a superseded row must stay reachable to fix or delete).
- **Retrieval is hybrid**: keyword FTS (OR-of-stemmed-words `to_tsquery`) plus pgvector cosine search merge via RRF (k=60) with the vector list's top 2 rows reserved unconditionally. Any embedding failure (Ollama down, no `embedding` column) degrades silently to keyword-only - never blocks a request. Query embed timeout is 750ms, write embed timeout 15s (writes embed fire-and-forget; a NULL embedding just means keyword-only until `bun run backfill`).
- **`memory_consolidate`** runs two passes (wording: trigram `>=0.8`; meaning: embedding cosine `>=0.83`, `CONSOLIDATE_EMBED_THRESHOLD`), capped at 25 clusters/pass. `isTemplatedAutoLog` excludes auto-generated log-shaped content from the meaning pass (boilerplate sentences with only an id/name swapped can cosine-match unrelated facts). `extractDetails`/`detailConflicts` additionally blocks an auto-merge when a specific number/path/proper-noun conflicts between two otherwise-similar memories, routing the pair to `[meaning-uncertain]` instead of deleting anything - it does no value normalization (`1,000` vs `1000`, `Jira` vs `JIRA` etc. can still be wrongly blocked). Supports `dryRun: true` (preview only, no deletes) - the wording pass's removed-row ids are excluded from the meaning pass's own query in **both** modes, so a preview and a same-snapshot real run report identical clusters (this was a real bug during dryRun's implementation: without the exclusion, dryRun's meaning pass would still see rows the wording pass "would remove" and double-report them).
- **`memory_tags`** lists distinct tags with counts (`uses DESC, tag ASC`), default limit 200 (raised from an original default of 50 after it was found to silently starve rare/low-count tags on a real corpus that already had ~50 distinct tags - exactly the tags worth checking before minting a near-duplicate).
- **Length nudge**: `memory_remember`/`memory_update` never reject for length below the hard 4000-char cap, but a write over 700 chars gets a non-blocking note appended to the success message (`CONTENT_LENGTH_NUDGE`) - 700 sits just above injection's 600-char-per-memory truncation point.
- **Supersede tracking**: `memory_remember`'s `supersedes: <id>` inserts the new row and sets the old row's `superseded_by` in one `sql.begin` transaction - a rejected supersede (wrong project, nonexistent id) rolls back the whole write, never leaves an orphaned insert.
- Write caps (`MAX_CONTENT` 4000, `MIN_CONTENT` 10, `MAX_TAGS` 10, `MAX_TAG_LENGTH` 64) are abuse guards sized against a real corpus, not style rules - oversized writes are rejected with the actual size, never truncated.

## Gotchas (Bun / opencode specifics that don't show up until something breaks)

- `dispose()` is **refcounted** - one opencode process shares this module across every project location it has open; an unrefcounted `sql.close()` would kill the pool for every other live project.
- Bun SQL array params need the element type: `sql.array(values, "text")`. A bare `sql.array(values)` quotes each element literally; a raw JS array throws `malformed array literal`.
- Never construct `new SQL("postgres://...")` from a URL string - it triggers a Node `DEP0169` warning under opencode's runtime. Use the options-object form (`makeSql()`).
- opencode must load this plugin via an **npm spec** (`@dzhi/ocpg`), not a GitHub `user/repo` spec - the latter hits a *different* `DEP0169` bug in opencode's own resolver (unrelated to the SQL one above). opencode's plugin cache only installs deps declared in `package.json`; an undeclared import fails **silently** (an event-bus toast only, nothing in logs) - always add a new runtime import as a real `dependencies` entry.
- Tool errors returned to the model are generic; the real driver message (host/user/schema) goes to `console.error` only, rate-limited **per kind** (`logError`) so one failing call type doesn't mute logs for another.
- SQLSTATE `42883` is special-cased in `toolError` to name the missing `pg_trgm` extension specifically; every other DB error gets a generic message.
- Keep module exports limited to `default`; extend `__internals` via the existing `Object.assign`, don't add new named exports.
- `README.md`'s tool list/count can lag `ocpg.ts` - `memory_tags` and `memory_consolidate`'s `dryRun` were both added to `ocpg.ts` without updating README's "Five agent tools" section in the same change. `ctx.tool.transform`'s `editor.add()` calls in `ocpg.ts` are the source of truth; update README (and `deploy/README.md` if the schema changed) in the same commit as a tool addition.

## Git / release workflow

- Never commit to `main` - feature branches only; the user pushes, merges, and tags.
- A commit that ships to npm needs its `package.json` version bump in the same branch - `.github/workflows/publish.yml` and the `tag-version-match` pre-push hook both reject a tag that doesn't match.
- Tag the merge commit on `main` (after the PR merges), never the branch head - tags must point into main's history.
