# Deploy Postgres container

Standalone Postgres for the ocpg plugin - hardened (read-only fs, no caps, localhost-only port), with schema auto-created on first boot.

## Run it

```bash
cp .env.example .env   # then fill in the values
docker compose up -d
```

That's it - on first boot the Postgres image creates the database named by `PG_DB`, and the `pg_trgm` extension plus the `memories` table (with full-text search indexes) are added by [`init/01-init.sh`](./init/01-init.sh).

## Upgrading an existing install

`init/01-init.sh` runs **only on first boot** (fresh data dir). Existing installs
apply the newer columns by hand, once, on the database the plugin points at:

```sql
-- memory_type (plugin >= 0.14): defaulted, never required. Existing rows read
-- as project_fact, which is what they were before the column existed.
ALTER TABLE memories ADD COLUMN IF NOT EXISTS memory_type text NOT NULL DEFAULT 'project_fact';
DO $$ BEGIN
  ALTER TABLE memories ADD CONSTRAINT memories_type_check
    CHECK (memory_type IN ('preference', 'project_fact', 'episodic'));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- recall access ranking (plugin >= 0.14): incremented by memory_recall only;
-- the injection path stays read-only.
ALTER TABLE memories ADD COLUMN IF NOT EXISTS access_count integer NOT NULL DEFAULT 0;
ALTER TABLE memories ADD COLUMN IF NOT EXISTS last_accessed_at timestamptz;

-- memory_update bookkeeping (plugin >= 0.14).
ALTER TABLE memories ADD COLUMN IF NOT EXISTS updated_at timestamptz;
```

Every statement is idempotent - re-running the block is a no-op.

`.env` values:

| Var           | Meaning                                          |
| ------------- | ------------------------------------------------ |
| `PUID`/`PGID` | Linux UID/GID owning `./data` (`id -u`, `id -g`) |
| `PG_USER`     | Postgres superuser name          |
| `PG_PASSWORD` | Postgres password                                |
| `PG_DB`       | Database the plugin reads/writes - any name you like |

Pick any `PG_USER`/`PG_DB` names you want - the plugin is name-agnostic; point its `OCPG_USER`/`OCPG_DB` env vars at whatever user and database you set up (healthcheck follows automatically).
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

The plugin reads its connection from env vars. Set them in `~/.zshenv` - any user, password, and database that exists on the Postgres you deployed works:

```bash
export OCPG_HOST="localhost"
export OCPG_PORT="5432"
export OCPG_USER="ocpguser"
export OCPG_PASSWORD="your-postgres-password"
export OCPG_DB="ocpg"
```
