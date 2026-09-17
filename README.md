# ocpg


Postgres-backed persistent memory plugin for [OpenCode](https://opencode.ai).

Uses the existing `memories` table (`content`, `tags`, `session_id`, `project`, `created_at`, `search_vector`) and the `pg_trgm` extension. Injects recent project memories into the system prompt and exposes `memory_recall` / `memory_remember` / `memory_forget` tools.

## Install

In `opencode.json`:

```json
{
  "plugin": [
    "@dzhi/ocpg"
  ]
}
```

## Connecting to the database

Need a Postgres instance? The [`deploy/`](./deploy) directory ships a hardened Docker Compose setup (localhost-only, `memories` schema auto-created on first boot) - see [`deploy/README.md`](./deploy/README.md).

Configure the connection via shell environment variables:

```bash
export OCPG_HOST="localhost"
export OCPG_PORT="5432"
export OCPG_USER="ocpguser"
export OCPG_PASSWORD="your-postgres-password"
export OCPG_DB="ocpg"
export OCPG_SSL="disable"
```

| Env var         | Default      |
| --------------- | ------------ |
| `OCPG_HOST`     | `localhost`  |
| `OCPG_PORT`     | `5432`       |
| `OCPG_USER`     | `ocpguser`   |
| `OCPG_DB`       | `ocpg`       |
| `OCPG_SSL`      | `disable`    |

`OCPG_SSL` accepts `disable`, `prefer`, `require`, `verify-ca`, or `verify-full` (anything else falls back to `disable`). It defaults to `disable` for the usual localhost setup - **set it to `require` or stricter whenever `OCPG_HOST` is not local**, otherwise the password handshake crosses the network in plaintext.

## Tools

Three agent tools are registered: `memory_remember` (store), `memory_recall` (search), and `memory_forget` (delete by id). The agent reads their usage rules from the tool schemas - as the user, the two things worth knowing are:

- Memories are scoped to the project directory they were stored from; recall only sees them cross-project when the agent explicitly asks for `global` search.
- `memory_forget` only ever deletes within the calling project.

Writes are capped at 4000 characters of content, 10 tags, and 64 characters per tag; oversized writes are rejected with the actual size rather than silently truncated.

### Duplicate detection

`memory_remember` rejects near-duplicates of existing memories in the same project instead of storing them.

This needs the `pg_trgm` extension. Fresh installs from [`deploy/`](./deploy) get it automatically; on an existing database run once:

```sql
CREATE EXTENSION pg_trgm;
```

Without it, `memory_remember` returns an error naming this exact fix.

If the database is unreachable, memory injection is skipped and the tools return a generic error - a slow or dead database never blocks a model request.

## Development

```bash
bun install
bun run check      # biome lint
bun run typecheck  # tsc --noEmit
bun test           # integration suite, needs a live Postgres with pg_trgm
```

Enable the commit hooks once per clone ([pre-commit](https://pre-commit.com)):

```bash
pre-commit install
```

It runs lint and typecheck on commits that touch `.ts` files. `bun test` is left out of the hook because it writes to a real database — CI runs it against a throwaway Postgres service container instead.
