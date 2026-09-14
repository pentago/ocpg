# Deploy Postgres container

Standalone Postgres for the ocpg plugin — hardened (read-only fs, no caps, localhost-only port), with schema auto-created on first boot.

## Run it

```bash
cp .env.example .env   # then fill in the values
docker compose up -d
```

That's it — on first boot the `agent-memory` database and the `memories` table (with full-text search indexes) are created automatically from [`init/01-init.sh`](./init/01-init.sh).

`.env` values:

| Var           | Meaning                                          |
| ------------- | ------------------------------------------------ |
| `PUID`/`PGID` | Linux UID/GID owning `./data` (`id -u`, `id -g`) |
| `PG_USER`     | Postgres superuser name          |
| `PG_PASSWORD` | Postgres password                                |
| `PG_DB`       | Database the plugin reads/writes (default `agent-memory`) |
Recommend `PG_USER=pguser` — it's the plugin's default. If you change it, pass `"user": "$PG_USER"`-equivalent in the plugin options (healthcheck follows automatically).

If you set a custom `PG_DB`, put the same name in the plugin's `"database"` option (or set the `OCPG_DB` env var).
Data lives in `./data` (gitignored). Nuke it to re-initialize.

## Wire up the plugin

In your `opencode.json`:

```json
{
  "plugin": [
    [
      "@dzhi/ocpg",
      {
        "host": "localhost",
        "port": 5432,
        "user": "pguser",
        "database": "agent-memory"
      }
    ]
  ]
}
```

**Password:** the plugin takes no password in config — it reads `OCPG_PASSWORD` from your environment. Use the same password you chose for `PG_PASSWORD` in `.env`:

Set in your shell profile, e.g. ~/.zshrc or store and call from `pass` CLI:

```bash
export OCPG_PASSWORD="your-postgres-password"
```
