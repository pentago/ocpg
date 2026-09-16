# AGENTS.md

ocpg is a single-file OpenCode plugin (`ocpg.ts`): a Postgres-backed persistent memory layer. It replaces the previous Postgres MCP memory server (same database, same schema). It registers a `ctx.session.hook("context", ...)` hook (injects project memories into system context) plus `memory_recall` / `memory_remember` tools (via `ctx.tool.transform`). Everything lives in `ocpg.ts`. The module exports **only `default`** (the `Plugin.define` object); test internals are attached to it as `Object.assign(ocpg, { __internals })` — tests do `import ocpg from "../ocpg"; const { __internals } = ocpg;`.

## Run

- Runtime is **Bun only** (no npm scripts, no tsconfig, no build/lint). Deps are `@opencode/plugin` (V2, matches the opencode release). Targets OpenCode **V2** (`Plugin.define`); V1 plugin code does not run in V2.
- Tests: `bun test tests/ocpg.test.ts` (or `bun test`). Uses `bun:test` + `bun:sql` (`SQL` class from `"bun"`), Postgres-specific SQL (`search_vector` FTS, `to_char`) — do not assume portability.

## Test prerequisites (integration tests hit a real DB)

- Live Postgres on `localhost:5432`, database `agent-memory`, table `memories` (columns: `content`, `tags`, `session_id`, `project`, `created_at`, `search_vector`).
- DB config resolution: plugin options (from `{ "package": "@dzhi/ocpg", "options": {...} }` under `plugins` in `opencode.jsonc`) > env > defaults. Env vars: `OCPG_HOST` (default `localhost`), `OCPG_PORT` (5432), `OCPG_USER` (pguser), `OCPG_DB` (agent-memory), `OCPG_PASSWORD`. The password is **env-only**, never via plugin options. Missing env password falls back to `Bun.spawnSync(["pass", "show", "postgres-workstation-password"])` at module init — importing `ocpg.ts` (or the tests) requires the local pass store (may need GPG/Yubikey).
- Tests assert `count(*) >= 1` and run `recall` against a hardcoded project dir `/home/dzhi/git/origo/vedurstofan-gitops` — the DB needs at least one memory row **for that exact project** or the recall test fails.

## Gotchas

- Tests run in file order; the **last test closes the shared pool** (`__internals.sql.close()`, inside the final rate-limit test) to simulate DB failure. Any DB-touching test added after it in the same process will fail — keep it last or restore the connection.
- Several tests assert latency (cold <200ms, warm <5ms) — cache behavior is part of the contract, don't remove the `injectionCache` (per-session, 32-slot eviction, invalidated on `remember`).
- The plugin must not spawn processes: only the `pass` lookup at module init (env password missing) is permitted; resolve credentials/config at init, not per-call.
- Forget/delete tools do not exist — `remember` dedups on write instead (exact match OR FTS on first 60 chars → false positives expected, see `ponytail:` comment; upgrade path is `pg_trgm`).
- Injected memory blocks truncate content to 600 chars.
- Deployment: published to npm as `@dzhi/ocpg` via GitHub Actions trusted publishing (`.github/workflows/publish.yml`, OIDC — tag-push or manual dispatch). opencode loads it via the npm spec; the GitHub `user/repo` spec triggers opencode's DEP0169 `url.parse()` resolver bug.
- Keep the module exports limited to `default` (the `Plugin.define` object); extend `__internals` via the existing `Object.assign` on the default export.
- Bun SQL array params need the element type: `sql.array(values, "text")` — bare `sql.array(values)` encodes text[] with quoted elements (each tag stored as `"tag"` with literal quotes), and a raw JS array throws `malformed array literal` (this silently broke `memory_remember` once — its test false-passed because `.catch(() => {})` swallowed the failed assertion inside `sql.begin`).
- Never construct `new SQL("postgres://…")` from a URL string — under opencode's runtime it emits the DEP0169 `url.parse()` warning at startup. Use the options-object constructor via `makeSql()`.
- `deploy/` — standalone Postgres for users: `compose.yaml` (hardened, localhost-only) + `init/01-init.sh` bootstraps the exact `agent-memory.memories` schema on first boot; setup docs in `deploy/README.md`.
