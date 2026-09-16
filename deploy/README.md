# Deploy Postgres container

Standalone Postgres for the ocpg plugin — hardened (read-only fs, no caps, localhost-only port), with schema auto-created on first boot.

## Run it

```bash
cp .env.example .env   # then fill in the values
docker compose up -d
```

That's it — on first boot the Postgres image creates the database named by `PG_DB`, and the `memories` table (with full-text search indexes) is added by [`init/01-init.sh`](./init/01-init.sh).

`.env` values:

| Var           | Meaning                                          |
| ------------- | ------------------------------------------------ |
| `PUID`/`PGID` | Linux UID/GID owning `./data` (`id -u`, `id -g`) |
| `PG_USER`     | Postgres superuser name          |
| `PG_PASSWORD` | Postgres password                                |
| `PG_DB`       | Database the plugin reads/writes — any name you like |

Pick any `PG_USER`/`PG_DB` names you want — the plugin is name-agnostic; point its `OCPG_USER`/`OCPG_DB` env vars at whatever user and database you set up (healthcheck follows automatically).
Data lives in `./data` (gitignored). Nuke it to re-initialize.

## Wire up the plugin

In your `opencode.json`:

```json
{
  "plugin": [
    "@dzhi/ocpg"
  ]
}
```

The plugin reads its connection from env vars. Set them in `~/.zshenv` — any user, password, and database that exists on the Postgres you deployed works:

```bash
export OCPG_HOST="localhost"
export OCPG_PORT="5432"
export OCPG_USER="ocpguser"
export OCPG_PASSWORD="your-postgres-password"
export OCPG_DB="ocpg"
```
