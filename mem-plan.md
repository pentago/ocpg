# Spec: `stack_fact` type — org-wide tooling memory vs. per-customer memory

## Problem statement

`memory_type` currently distinguishes `preference` (global, personal to the
operator) from `project_fact` (global today, but conceptually meant to be
"stuff learned in this project"). In practice `project_fact` is doing two
jobs that need opposite visibility:

1. **Stack/tooling knowledge** — facts about a shared toolchain (Terraform
   module quirks, ArgoCD ApplicationSet gotchas, Helm chart conventions) that
   are true across every customer project using the same stack, because
   what was learned is about the *tool*, not the *customer*. Example:
   "our RDS Terraform module needs `lifecycle { ignore_changes = [...] }`
   because Aurora auto-applies parameter group changes out of band."

2. **Customer-specific knowledge** — facts that are true of exactly one
   customer's environment and would be wrong, confusing, or embarrassing if
   they surfaced while working on a different customer's repo. Example:
   "customer A's staging cluster has a flaky DNS resolver; re-run `terraform
   apply` if you see a timeout on the first try."

Today both get typed `project_fact` and both are globally visible (or
globally invisible, depending on how injection ranks them) with no way to
tell them apart at the visibility layer. This spec adds a third memory type,
`stack_fact`, to split them.

## Goals

- Preserve global visibility for genuinely cross-customer tooling knowledge
  (the primary reason this type exists).
- Make `project_fact` visible-by-default only in its origin project, with
  explicit opt-in (`global: true`) to reach across projects — restoring the
  isolation guarantee that existed before scoping was unified, but only for
  this one type.
- Do this entirely inside the existing `memory_type` mechanism — no new
  column, no new table, no separate scoping system alongside `project`.
- Keep `preference` behavior completely unchanged.
- Keep the change backward-compatible: every existing `project_fact` row
  keeps working exactly as it does today (globally visible) until someone
  re-types it.

## Non-goals

- No automatic classification of which type a fact belongs to. The model
  (or the human) declares the type at write time, same as it already does
  for `preference` vs `project_fact`. This spec does not attempt to
  auto-detect "is this customer-specific."
- No per-customer/per-tenant ACLs or auth. `project` remains a plain string
  (the directory path); there's no customer identity concept beyond that.
- No retroactive re-classification of existing rows. Existing `project_fact`
  memories are not touched by this change — see Migration below for the
  explicit, opt-in path to re-type them.

## Design

### 1. New type value

Extend the existing type vocabulary:

```ts
const MEMORY_TYPES = ["preference", "stack_fact", "project_fact", "episodic"] as const;
```

Update the DB CHECK constraint (`memories_type_check`) to match. Order
matters only for the tool-description enum list — no ranking logic depends
on array order.

Semantics of each type after this change:

| Type          | Visibility                         | What it's for                                      |
|---------------|-------------------------------------|-----------------------------------------------------|
| `preference`  | Global (unchanged)                  | Personal to the operator, not about any codebase.   |
| `stack_fact`  | Global (new)                        | True about the tooling/stack, portable across every project that uses it. |
| `project_fact`| **Origin project only, by default** (changed) | True about this specific project/customer; not assumed portable. |
| `episodic`    | Reserved, unused (unchanged)        | —                                                    |

### 2. `recall` — project-scope `project_fact` by default

`recall` currently has no project filter at all. Add one, conditional on
type and the new `global` flag:

```ts
type RecallArgs = { query?: string; limit?: number; tags?: string[]; global?: boolean };
```

Visibility rule for the WHERE clause, added alongside the existing
`queryCond` / `tagCond`:

- If `args.global` is true: no project filter (current behavior, everything
  visible) — same escape hatch that existed pre-unification, just brought
  back for this purpose.
- If `args.global` is false/omitted (default): a row is visible if
  **either** `memory_type != 'project_fact'` **or** `project = ctx.directory`.
  In SQL: `(memory_type != 'project_fact' OR project = ${ctx.directory})`.

This means `preference`, `stack_fact`, and `episodic` rows are always
visible regardless of the `global` flag; only `project_fact` rows are
filtered to the calling project unless `global: true` is passed. `recall`
needs `ctx.directory` threaded through again (it was dropped when scoping
was unified — reintroduce it as a parameter, same shape as `remember`
already takes).

Tool schema update for `memory_recall`:

```ts
global: {
  type: "boolean",
  description:
    "Also search other projects' project_fact memories (default: only this " +
    "project's project_fact memories, plus all preference/stack_fact memories, " +
    "which are always global).",
},
```

### 3. Injection — same visibility rule, both query builders

`buildRecencyQuery` and `buildRelevanceQuery` both currently select from
`memories` with no project filter. Apply the identical visibility predicate
used in `recall`:

```sql
WHERE (memory_type != 'project_fact' OR project = ${directory})
```

added as a `WHERE`/`AND` clause in both builders (relevance query already
has a `WHERE search_vector @@ ...` clause to extend with `AND`; recency
query gains its first `WHERE`).

This is not optional/flagged — injection should never surface another
project's `project_fact` memories, since there's no `global` flag available
at injection time (the model isn't asking a question, it's ambient
context). The same-project rank boost in `buildRelevanceQuery`
(`+0.01 WHEN project = directory`) stays as-is; it now only matters for
breaking ties among the non-`project_fact` types, since `project_fact` rows
from other projects are filtered out entirely rather than merely
down-ranked.

### 4. `forget` and `memory_update` — scope deletion/edits to `project_fact`'s new rule

Currently `forget` deletes by id with no project check at all ("any project
can delete any of them," per the existing tool description). Under the new
model this is too permissive specifically for `project_fact`: a customer
B agent should not be able to delete customer A's `project_fact` memory
just because it knows the id.

Change `forget` to check the row's own type before deleting:

```sql
DELETE FROM memories
WHERE id = ${id}
  AND (memory_type != 'project_fact' OR project = ${ctx.directory})
RETURNING id
```

If this deletes 0 rows because the id exists but belongs to another
project's `project_fact`, return a message that distinguishes "doesn't
exist" from "exists but not yours":

```ts
if (deleted.length === 0) {
  const exists = await sql`SELECT project, memory_type FROM memories WHERE id = ${id}` as
    { project: string; memory_type: string }[];
  if (exists.length > 0) {
    return `Memory #${id} is a project_fact belonging to another project; not deleted. ` +
           `Only that project's agent can delete it.`;
  }
  return `No memory #${id}; nothing deleted.`;
}
```

Apply the identical WHERE clause and existence-check pattern to
`updateMemory` — same reasoning: rewriting another customer's
`project_fact` in place is the same boundary violation as deleting it.

`stack_fact` and `preference` remain deletable/editable from any project,
unchanged — they're global facts and any project's agent maintaining them
is legitimate, same as today.

### 5. `remember` and `validateWrite` — no changes needed

`resolveMemoryType` already validates against `MEMORY_TYPES`; adding
`stack_fact` to that array is sufficient. No other change to the write
path — a `stack_fact` write and a `project_fact` write go through the exact
same `remember()` function, differing only in the stored `memory_type`
value. This is intentional: the classification decision lives entirely in
the model choosing which type to pass, not in any code branch.

### 6. Tool description — teach the distinction

The `memory_remember` tool description is, per the existing code comments,
"the only place the write policy is guaranteed to reach the model." Update
it to give a concrete, memorable test rather than an abstract rule:

```ts
type: {
  type: "string",
  enum: [...MEMORY_TYPES],
  description:
    "preference = a standing user preference (global, injected first). " +
    "stack_fact = true about the tooling/stack itself, portable to any project " +
    "using the same stack (e.g. a Terraform module quirk, an ArgoCD gotcha, a " +
    "Helm chart convention) - global, like preference. " +
    "project_fact (default) = true about THIS specific project/customer only " +
    "(an environment quirk, a customer's specific request, a one-off workaround) " +
    "- visible only in this project unless the caller asks for global search. " +
    "Test: would this fact help in a different customer's repo using the same " +
    "tools? If yes, stack_fact. If no, project_fact.",
},
```

The "test" sentence is the single highest-value addition here — it's the
concrete question from the design discussion, turned into something the
model can apply mechanically at write time.

### 7. Migration for existing rows

No automatic re-typing. Every row currently typed `project_fact` keeps that
type and, after this change ships, **becomes project-scoped where it
previously was global** — this is the one behavior change that isn't purely
additive, so it needs to be called out.

Two options, not mutually exclusive:

- **Do nothing.** Existing `project_fact` rows quietly become
  project-scoped. Any of them that were actually cross-project tooling
  knowledge stop surfacing elsewhere until someone notices and re-types
  them with `memory_update(id, ..., type: "stack_fact")`. This is the
  simplest option and is acceptable if the existing corpus is small enough
  to review manually.
- **One-time audit tool.** Add a temporary admin script (not a permanent
  agent-facing tool) that lists all `project_fact` rows grouped by
  similarity-to-rows-in-other-projects, as a hint for which ones are likely
  stack knowledge misfiled as project-specific. This is a nice-to-have, not
  required for the feature to ship — skip it unless the existing corpus is
  large enough that manual review is impractical.

Recommendation: ship with "do nothing," and mention the re-typing path
(`memory_update` with a new `type`) in the README's upgrade notes so users
know how to promote a memory that turns out to be more broadly useful than
its origin project.

## Testing

Extend the existing test suite (`tests/`) with:

- `recall` with default (`global` omitted/false): a `project_fact` written
  from project A is not returned when recalling from project B; a
  `stack_fact` written from project A **is** returned from project B.
- `recall` with `global: true`: project A's `project_fact` is returned from
  project B.
- Injection: a `project_fact` from project A does not appear in project B's
  injected block (relevance mode and recency-fallback mode both); a
  `stack_fact` from project A does appear in project B's injected block.
- `forget`: deleting another project's `project_fact` id returns the
  "belongs to another project" message and does not delete the row;
  deleting another project's `stack_fact` id succeeds.
- `updateMemory`: same pair of cases as `forget`.
- `validateWrite`/`resolveMemoryType`: `stack_fact` is accepted as a valid
  type value; an invalid type string still rejects with the same error
  message format, now listing `stack_fact` in the allowed set.
- Backward compatibility: a row inserted before this change (type
  `project_fact`, no migration applied) is scoped to its `project` column
  under the new default recall/injection behavior — i.e., confirm the new
  WHERE clause applies uniformly regardless of when the row was written.

## Explicitly out of scope for this spec

- Auto-classifying `stack_fact` vs `project_fact` via an LLM pass. If
  misclassification turns out to be a frequent real problem after this
  ships, that's a separate follow-up spec, not part of this one — per the
  project's existing principle that model judgment on the write path stays
  a single explicit choice (the `type` field), not a hidden inference step.
- Any notion of "customer" or "tenant" as a first-class concept distinct
  from `project` (the directory path). If multiple customers ever share one
  project directory, or one customer spans multiple directories, this spec
  does not address that — `project` remains the only identity ocpg has.
- Changing `preference` or `episodic` behavior in any way.
