# AGENTS.md

opmem is a single-file OpenCode plugin (`opmem.ts`): a Postgres-backed persistent memory layer. It registers a `experimental.chat.system.transform` hook (injects project memories into system context) plus `memory_recall` / `memory_remember` tools. Everything lives in `opmem.ts`; `__internals` exports the internals for testing.

## Run

- Runtime is **Bun only** (no npm scripts, no tsconfig, no build/lint). Deps are `@opencode-ai/plugin` + `zod`.
- Tests: `bun test tests/opmem.test.ts` (or `bun test`). Uses `bun:test` + `bun:sql` (`SQL` class from `"bun"`), Postgres-specific SQL (`search_vector` FTS, `to_char`) — do not assume portability.

## Test prerequisites (integration tests hit a real DB)

- Live Postgres on `localhost:5432`, database `agent-memory`, table `memories` (columns: `content`, `tags`, `session_id`, `project`, `created_at`, `search_vector`).
- Credentials resolve at module import: env `POSTGRES_MEMORY_MCP_USER` / `POSTGRES_MEMORY_MCP_PASSWORD`, falling back to `Bun.spawnSync(["pass", "show", "postgres-workstation-password"])`. Importing `opmem.ts` (or the tests) requires the local pass store (may need GPG/Yubikey).
- Tests assert `count(*) >= 1` and run `recall` against a hardcoded project dir `/home/dzhi/git/origo/vedurstofan-gitops` — the DB needs at least one memory row **for that exact project** or the recall test fails.

## Gotchas

- Tests run in file order; the **last test closes the shared pool** (`__internals.sql.close()`) to simulate DB failure. Any test added after it in the same process will fail — keep it last or restore the connection.
- Several tests assert latency (cold <200ms, warm <5ms) — cache behavior is part of the contract, don't remove the `injectionCache` (per-session, 32-slot eviction, invalidated on `remember`).
- The plugin must not spawn processes: the `pass` lookup at module init (line ~13) is the only permitted spawn; resolve credentials/config at init, not per-call.
- Forget/delete tools do not exist — `remember` dedups on write instead (exact match OR FTS on first 60 chars → false positives expected, see `ponytail:` comment; upgrade path is `pg_trgm`).
- Injected memory blocks truncate content to 600 chars.
- Deployment: installed from GitHub (`pentago/opmem`).
