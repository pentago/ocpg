# ocpg


Postgres-backed persistent memory plugin for [OpenCode](https://opencode.ai).

Uses the `memories` table (`content`, `tags`, `session_id`, `project`, `created_at`, `search_vector`, `memory_type`, `access_count`, `last_accessed_at`, `updated_at`) and the `pg_trgm` extension. Injects the memories most relevant to what you're currently asking into the system prompt, captures deliberate "remember that..." prompts verbatim, and exposes `memory_recall` / `memory_remember` / `memory_forget` / `memory_update` tools.

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
| `OCPG_USER_ID`  | _(unset)_    |

`OCPG_SSL` accepts `disable`, `prefer`, `require`, `verify-ca`, or `verify-full` (anything else falls back to `disable`). It defaults to `disable` for the usual localhost setup - **set it to `require` or stricter whenever `OCPG_HOST` is not local**, otherwise the password handshake crosses the network in plaintext.

Set `OCPG_USER_ID` to a short identifier to enable **user scope**: memories stored with `scope: "user"` live under a `user:<id>` sentinel and are injected into every project's context (and deletable from any project, by design). Unset, user scope is disabled entirely.

## How injection picks memories

By default the block is **relevance-ranked, not recency-ranked**: the user's latest prompt is turned into a full-text query (OR of stemmed words) over **all projects**, ranked by relevance with a small same-project tiebreak, top 5 injected. Working on similar projects for different clients means a memory written anywhere can surface in any project. When nothing matches the prompt, it falls back to the latest memories (preferences first). Set `OCPG_INJECTION=recency` for the old blind-last-5 behavior.

This is keyword relevance, not embedding-based semantic search - close phrasing wins, paraphrases may not. Note the OR ranking: common words in a prompt surface more rows; the ranking favors rows matching more distinctive terms.

## Tools

Four agent tools are registered: `memory_remember` (store), `memory_recall` (search), `memory_forget` (delete by id), and `memory_update` (rewrite an existing memory, keeping its original learned date). The agent reads their usage rules from the tool schemas - as the user, the things worth knowing are:

- Memories are scoped to the project directory they were stored from; recall only sees them cross-project when the agent explicitly asks for `global` search (or stores them in user scope).
- `memory_forget` / `memory_update` only touch memories of the calling project - plus, when user scope is enabled, the shared user memories.

Writes are capped at 4000 characters of content, 10 tags, and 64 characters per tag; oversized writes are rejected with the actual size rather than silently truncated. Memories carry a `type` (`preference`, `project_fact` default, or `episodic`); `preference` memories are injected ahead of newer facts.

Saying "remember that ..." (or "don't forget ...", "keep in mind ...") in a prompt stores the text after the phrase verbatim, tagged `user-requested` - no model judgment involved.

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
