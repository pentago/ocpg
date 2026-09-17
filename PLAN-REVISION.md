# ocpg plan — review verdict + revision

Review of the improvement gameplan against `ocpg.ts`, `deploy/init/01-init.sh`,
the V2 plugin docs, and the project's established decisions (memory #1555 et al).

## Verdict per item

| Item | Verdict | Why |
|---|---|---|
| 1.1 keyword capture | **Revise** | Drop LLM extraction of "relevant content"; store user text verbatim |
| 1.2 user scope | **Revise** | Sentinel project value, no migration, no git-email process spawn |
| 1.3 compaction summary | **Cut / defer** | Contradicts the thin-write policy; depends on 2.1; opt-in only if ever |
| 2.1 memory_type | **Keep, pull forward** | 1.3 needs it; trivial migration |
| 2.2 access ranking | **Keep, narrow** | Increment on recall only; injection path stays read-only |
| 2.3 memory_update | **Keep** | Unchanged from plan |
| Stage 3 | **Keep** | Plan already gates it on measurement; agree |

## Revisions in detail

### 1.1 — keyword capture (revised)

`ctx.session.hook("prompt", ...)` exists and works (V2 docs: prompt admission
hook, mutable `event.prompt.text`). But the original says "auto-fire a
`memory_remember` call with the relevant content" — extracting "relevant
content" is an LLM judgment on the prompt-admission path: added latency,
nondeterministic, and it violates the memory #1555 rule (never make model
judgment load-bearing). It also contradicts the manual tool's own write policy
("do not store session progress").

Revised behavior:
- Deterministic keyword match ("remember this", "don't forget", …) → store the
  text following the keyword **verbatim** (minus the trigger phrase), tagged
  `user-requested`, through the same `validateWrite` + trigram dedup path.
- No `ctx.generate.text` call in this path. If the verbatim text is junk, dedup
  and the 10-char minimum catch the worst; the user can `memory_forget` it.
- Prompt hooks are not exactly-once (docs: concurrent submissions can run hooks
  more than once) — dedup-on-write is the guard; do not add a hook-side
  deduplication layer.
- Keep the manual tool untouched, per the plan.

### 1.2 — user scope (revised: no migration, no process spawn)

Original derives a user id from `git config user.email` — that spawns a
process, which the plugin explicitly forbids (env-only config, no child
processes). It also adds a `user_id`/`scope` column, i.e. a schema migration.

Revised design:
- Sentinel scope value in the **existing** `project` column: `user:<id>` where
  `<id>` comes from `OCPG_USER_ID` (env, resolved once at init). Unset → user
  scope disabled entirely; zero behavior change for existing installs.
- `memory_remember` gains `scope: "project" | "user"` (default `project`);
  `scope: "user"` writes with `project = "user:<id>"`.
- `memory_recall` gains the same param; `global: true` already covers user rows.
- Injection query becomes `WHERE project = $dir OR project = "user:<id>"`
  (only when `OCPG_USER_ID` is set); injection cache key stays the directory —
  the query still depends only on the directory.
- **Authorization note**: `memory_forget` currently scopes to
  `project = directory`. It must also match the user-scope sentinel, or agents
  can see user memories but never delete them. This widens the boundary
  deliberately (user scope is shared by design) — document it in the tool
  description, don't hide it.
- Rationale: identical behavior to a `scope` column with zero migration and a
  trivial upgrade path (an `UPDATE` to a real column later, if ever needed).

### 1.3 — compaction summary (cut from Stage 1)

Three problems:
1. **It contradicts the project's own policy.** The tool description forbids
   session progress memories; the existing architecture decision rejects thin
   episodic writes because injection is `ORDER BY created_at DESC LIMIT 5` —
   per-compaction summaries would evict durable memories from the only 5
   injected slots. The plan's ground rules say don't relitigate this; 1.3
   relitigates it.
2. **The stated gap doesn't exist.** OpenCode's compaction summary is appended
   to the same session's transcript — compaction continuity is already solved
   by OpenCode itself. Cross-*session* continuity is a different feature
   (episodic memory) and a policy change, not a capture hook.
3. **It needs 2.1 first** (an `episodic` type so injection can rank it below
   durable memories) and an LLM call via `ctx.generate.text` per compaction.

If it's ever wanted: opt-in via `OCPG_EPISODIC=1`, typed `episodic`, excluded
from the 5-slot injection or capped at 1 slot. Revisit only after Stage 2 and
only if cross-session recall gaps show up in real use.

### 2.1 — memory_type (keep, pull forward before 1.3)

- `ALTER TABLE memories ADD COLUMN IF NOT EXISTS memory_type text
  NOT NULL DEFAULT 'project_fact'` — plus a CHECK constraint for the allowed
  set (`preference`, `project_fact`, `episodic`).
- `type` is **defaulted, never required** (plan says "required or defaulted" —
  required breaks every existing caller and stored row).
- Tags stay for fine-grained facets; the tag-prefix convention in the tool
  description gets replaced by the typed field.
- Injection: `preference` rows first, then recency; this composes with 2.2.
- Init script gains the column for fresh installs (CI bootstraps from the real
  script, so drift fails the build — keep it that way).

### 2.2 — access ranking (keep, narrowed)

- **Recall only**: `access_count` / `last_accessed_at` incremented by the
  recall SELECT (fire-and-forget UPDATE, not on the read path's latency).
- **Injection stays read-only.** The per-directory injection cache means
  injection-driven increments would fire once per cache window and be biased;
  making them accurate means an UPDATE on every model request, which is write
  amplification on the hottest path in the plugin for a weak signal.
- Undirected recall ordering becomes a recency×frequency blend; injection keeps
  `ORDER BY created_at DESC` (with 2.1's type-aware ordering). Honest framing:
  this narrows the plan's claim of "closing the retrieval-quality gap" to
  "improving undirected recall" — directed (query) recall is already
  ts_rank-ranked and gains nothing here.
- Index: `(project, access_count DESC)` only if measurement shows need.

### 2.3 — memory_update (keep as planned)

- Project-scoped `WHERE id = $1 AND project = $2` like forget (user-scope
  sentinel added per 1.2 revision).
- No dedup fall-through, by design.
- Add `updated_at timestamptz`; do **not** bump `created_at` (the displayed
  date would lie about when the memory was learned).

## New Stage 0 — migration path for existing DBs (missing from the plan)

`deploy/init/01-init.sh` runs only on first boot. Every existing install
(including the 485-memory corpus) needs:

```sql
ALTER TABLE memories ADD COLUMN IF NOT EXISTS memory_type text NOT NULL DEFAULT 'project_fact';
ALTER TABLE memories ADD CONSTRAINT memories_type_check
  CHECK (memory_type IN ('preference', 'project_fact', 'episodic'));  -- 2.1
ALTER TABLE memories ADD COLUMN IF NOT EXISTS access_count integer NOT NULL DEFAULT 0;      -- 2.2
ALTER TABLE memories ADD COLUMN IF NOT EXISTS last_accessed_at timestamptz;                 -- 2.2
ALTER TABLE memories ADD COLUMN IF NOT EXISTS updated_at timestamptz;                       -- 2.3
```

…documented in `deploy/README.md` as an upgrade step, with the init script
updated to match (CI bootstraps from the real script — no copies, no drift).

## Revised order

1. **Stage 0**: migration docs + init script (enables everything else).
2. **1.1 revised** (verbatim keyword capture — no LLM, no migration).
3. **1.2 revised** (sentinel user scope — no migration).
4. **2.1** (memory_type column + type-aware injection).
5. **2.3** (memory_update).
6. **2.2 narrowed** (recall-only access ranking).
7. ~~1.3~~ — cut; revisit as opt-in episodic only after 4–6 prove insufficient.

Original order had 1.3 third; it's last and possibly never. Everything else
keeps the plan's ROI ordering. Stage 3 unchanged — validate need by measurement
first, exactly as the plan says.
