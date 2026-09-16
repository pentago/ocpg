# ocpg


Postgres-backed persistent memory plugin for [OpenCode](https://opencode.ai).

Uses the existing `memories` table (`content`, `tags`, `session_id`, `project`, `created_at`, `search_vector`). Injects recent project memories into the system prompt and exposes `memory_recall` / `memory_remember` tools.

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

Need a Postgres instance? The [`deploy/`](./deploy) directory ships a hardened Docker Compose setup (localhost-only, `memories` schema auto-created on first boot) — see [`deploy/README.md`](./deploy/README.md).

Configure the connection via environment variables, e.g. in `~/.zshenv`. Any Postgres user and database name will do — use whatever names fit your setup and mirror them here:

```bash
export OCPG_HOST="localhost"
export OCPG_PORT="5432"
export OCPG_USER="ocpguser"
export OCPG_PASSWORD="your-postgres-password"
export OCPG_DB="ocpg"
```

| Env var         | Default      |
| --------------- | ------------ |
| `OCPG_HOST`     | `localhost`  |
| `OCPG_PORT`     | `5432`       |
| `OCPG_USER`     | `ocpguser`   |
| `OCPG_DB`       | `ocpg`       |

**Password is env-only.** The plugin never reads config files, options, or external secret managers — set `OCPG_PASSWORD` in your shell environment (e.g. via direnv/.envrc, however you source your secrets).

## Tools

- `memory_remember` — store a memory (dedups against similar entries per project)
- `memory_recall` — search past memories (`query`, `global`, `limit`)

Memories are project-scoped by working directory; use `global: true` on recall to search across projects.
