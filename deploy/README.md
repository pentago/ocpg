# Deploy Postgres container

Standalone Postgres for the ocpg plugin - hardened (read-only fs, no caps, localhost-only port), with schema auto-created on first boot.

## Run it

```bash
cp .env.example .env   # then fill in the values
docker compose up -d
```

That's it - on first boot the Postgres image creates the database named by `PG_DB`, and the `pg_trgm` extension plus the `memories` table (with full-text search indexes) are added by [`init/01-init.sh`](./init/01-init.sh).

The compose file also includes an optional `ollama` service (the embedding backend for hybrid search). It starts with everything else but does nothing until you pull a model once:

```bash
docker exec ollama ollama pull bge-m3
```

CPU-only by default, which suffices - ocpg's embeds are short and rare (~95ms warm, ~1.1s cold load, measured with the shipped 4-CPU limit, vs the plugin's 750ms query budget). A GPU reservation block is commented in `compose.yaml` for hosts with nvidia-container-toolkit; it matters for bulk re-embeds at 50k+ rows, not daily use. Prefer your own host-installed Ollama instead? Just don't start the service - the plugin's defaults (`OCPG_OLLAMA_HOST=localhost`, `OCPG_OLLAMA_PORT=11434`) match either.

## Upgrading an existing install

`init/01-init.sh` runs **only on first boot** (fresh data dir). Existing installs
apply the newer columns by hand, once, on the database the plugin points at:

```sql
-- pg_trgm backs near-duplicate handling (memory_consolidate, injection collapse).
CREATE EXTENSION IF NOT EXISTS pg_trgm;

-- memory_type (plugin >= 0.14): defaulted, never required. Existing rows read
-- as project_fact, which is what they were before the column existed.
ALTER TABLE memories ADD COLUMN IF NOT EXISTS memory_type text NOT NULL DEFAULT 'project_fact';
ALTER TABLE memories DROP CONSTRAINT IF EXISTS memories_type_check;
ALTER TABLE memories ADD CONSTRAINT memories_type_check
  CHECK (memory_type IN ('preference', 'stack_fact', 'project_fact', 'episodic'));

-- preference removed (plugin >= 0.15): AGENTS.md now covers the "applies
-- everywhere" use case better than a relevance-ranked memory ever could.
-- Delete existing preference rows and tighten the constraint - do this only
-- once every preference-typed row has been reviewed (they're gone after).
DELETE FROM memories WHERE memory_type = 'preference';
ALTER TABLE memories DROP CONSTRAINT IF EXISTS memories_type_check;
ALTER TABLE memories ADD CONSTRAINT memories_type_check
  CHECK (memory_type IN ('stack_fact', 'project_fact', 'episodic'));

-- recall access ranking (plugin >= 0.14): incremented by memory_recall only;
-- the injection path stays read-only.
ALTER TABLE memories ADD COLUMN IF NOT EXISTS access_count integer NOT NULL DEFAULT 0;
ALTER TABLE memories ADD COLUMN IF NOT EXISTS last_accessed_at timestamptz;

-- memory_update bookkeeping (plugin >= 0.14).
ALTER TABLE memories ADD COLUMN IF NOT EXISTS updated_at timestamptz;

-- memory_consolidate (plugin >= 0.14): trigram content index for the
-- near-duplicate self-join.
CREATE INDEX IF NOT EXISTS idx_memories_trgm ON memories USING gin (content gin_trgm_ops);

-- Hybrid retrieval: the embedding half of keyword+vector search. Requires the
-- pgvector image (compose.yaml swapped postgres:18-alpine ->
-- pgvector/pgvector:0.8.6-pg18-trixie). The column dimension is tied to the
-- embedding model (bge-m3 = 1024).
CREATE EXTENSION IF NOT EXISTS vector;
ALTER TABLE memories ADD COLUMN IF NOT EXISTS embedding vector(1024);
CREATE INDEX IF NOT EXISTS idx_memories_embedding ON memories USING hnsw (embedding vector_cosine_ops);

-- Cross-session recall signal: which SESSIONS have independently recalled a
-- memory, not how many times (that's access_count, unused by ranking - see
-- ocpg.ts's crossSessionBoost comment). The PRIMARY KEY makes repeated
-- recalls within one session count once, which is what makes this safe to
-- use as a small ranking tiebreak.
CREATE TABLE IF NOT EXISTS memory_recalls (
  memory_id  integer NOT NULL REFERENCES memories(id) ON DELETE CASCADE,
  session_id text NOT NULL,
  recalled_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (memory_id, session_id)
);
```

Every statement is idempotent - re-running the block is a no-op.

### Swapping to the pgvector image

`pgvector/pgvector` is a Debian build while the old image was Alpine
(musl->glibc). Same Postgres major version, so the data dir keeps working;
if the logs show collation-version warnings after the swap, run
`REINDEX DATABASE <your-db>;` once. Then fill embeddings for pre-existing
rows (until this runs they are found by keyword search only):

```bash
bun run backfill   # same OCPG_* env as the plugin; idempotent, re-runnable
```

Semantic search needs a reachable Ollama with the model pulled
(`ollama pull bge-m3`) - host-installed or the compose `ollama` service, the
plugin defaults match either. Without Ollama everything still works - search
just stays keyword-only, and `memory_consolidate`'s meaning pass simply has
no embedded rows to compare.

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

Optional, for the embedding half of hybrid search: `OCPG_OLLAMA_HOST` (default `localhost`), `OCPG_OLLAMA_PORT` (default `11434`), `OCPG_EMBED_MODEL` (default `bge-m3`; a model with different output dimensions needs the `embedding` column re-created at that size plus a re-run of the backfill).
