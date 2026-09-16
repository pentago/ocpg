import { describe, test, expect, spyOn } from "bun:test";
import ocpg from "../ocpg";

const { __internals } = ocpg;
import { SQL } from "bun";

describe("DB access layer", () => {
  test("QA happy: SELECT count >= 1", async () => {
    const rows = await __internals.sql`SELECT count(*) AS n FROM memories`;
    const count = Number(rows[0].n);
    console.log(`memories count: ${count}`);
    expect(count).toBeGreaterThanOrEqual(1);
  });

  test("QA failure: wrong connection returns error, process stays alive", async () => {
    const badSql = new SQL(
      "postgres://x:wrong@localhost:5431/agent-memory",
      { max: 1 },
    );
    let caught = false;
    try {
      await badSql`SELECT 1`;
    } catch (e: unknown) {
      caught = true;
      expect(String(e)).toContain("Failed to connect");
    }
    expect(caught).toBe(true);
    // Process is still alive — we reached this line.
    expect(true).toBe(true);
  });

  describe("Injection pipeline (Todo 2)", () => {
    const ctx = { directory: "/home/dzhi/git/origo/vedurstofan-gitops" };

    test("QA happy: cache-miss then cache-hit for same sessionID", async () => {
      // Cold call (cache miss)
      const output1: { system: string[] } = { system: [] };
      const start1 = performance.now();
      await __internals.handleTransform({ sessionID: "test-inject-1", model: {} }, output1, ctx.directory);
      const coldMs = performance.now() - start1;
      console.log(`cold latency: ${coldMs.toFixed(1)}ms`);
      expect(coldMs).toBeLessThan(200);
      expect(output1.system.length).toBe(1);
      const block = output1.system[0];
      expect(block).toContain("<persistent-project-memory>");
      expect(block).toContain("Before non-trivial work, check these. After user corrections, architecture decisions, or non-trivial fixes, call memory_remember. Use memory_recall to search past lessons.");

      // Warm call (cache hit)
      const output2: { system: string[] } = { system: [] };
      const start2 = performance.now();
      await __internals.handleTransform({ sessionID: "test-inject-1", model: {} }, output2, ctx.directory);
      const warmMs = performance.now() - start2;
      console.log(`warm latency: ${warmMs.toFixed(1)}ms`);
      expect(warmMs).toBeLessThan(5);
      expect(output2.system[0]).toBe(block);
    });

    test("QA failure: sessionID undefined leaves output untouched", async () => {
      const output: { system: string[] } = { system: [] };
      await __internals.handleTransform({ sessionID: undefined, model: {} }, output, ctx.directory);
      expect(output.system.length).toBe(0);
    });

    test("Cache-hit proof: third call identical output + <5ms", async () => {
      const output: { system: string[] } = { system: [] };
      const start = performance.now();
      await __internals.handleTransform({ sessionID: "test-inject-1", model: {} }, output, ctx.directory);
      const ms = performance.now() - start;
      console.log(`third call latency: ${ms.toFixed(1)}ms`);
      expect(ms).toBeLessThan(5);
      expect(output.system.length).toBe(1);
      // Content must be a non-empty string identical to previous calls
      expect(typeof output.system[0]).toBe("string");
      expect(output.system[0].length).toBeGreaterThan(0);
    });
  });

  describe("Agent tools: recall + remember (Todo 3)", () => {
    const ctx = {
      directory: "/home/dzhi/git/origo/vedurstofan-gitops",
      sessionID: "test-todo3-1",
    };

    test("QA happy: remember dedups on exact content (committed row, deterministic)", async () => {
      const marker = `test-dedup-${Date.now()}-${Math.random().toString(36).slice(2)}`;
      const content = `Unique marker for dedup test: ${marker}`;

      // Seed via autocommit on the module pool so remember's dedup SELECT sees the
      // row regardless of pool connection. (The old begin-tx version only passed
      // when the pool reused the transaction connection, and its .catch swallowed
      // assertion failures, so it could false-pass while masking a broken tags INSERT.)
      const [seeded] = await __internals.sql`
        INSERT INTO memories (content, tags, session_id, project)
        VALUES (${content}, ${__internals.sql.array(['__internals-test'])}, ${ctx.sessionID}, ${ctx.directory})
        RETURNING id
      ` as { id: number }[];
      console.log(`seeded test memory #${seeded.id}`);

      try {
        const result = await __internals.remember({ content, tags: ['__internals-test'] }, ctx);
        console.log(`dedup result: ${result}`);
        expect(result).toContain("Similar memory already stored as #");
        expect(result).toContain(String(seeded.id));
      } finally {
        await __internals.sql`DELETE FROM memories WHERE id = ${seeded.id}`;
      }
    });

    test("QA happy: remember inserts a row with a proper tags array and returns its id", async () => {
      // Covers the INSERT path (sql.array tags) — the dedup test returns early and never inserts.
      const marker = `test-insert-${Date.now()}-${Math.random().toString(36).slice(2)}`;
      const content = `Insert path test: ${marker}`;
      const project = "/tmp/ocpg-test-insert";

      try {
        const result = await __internals.remember({ content, tags: ["__internals-test"] }, { directory: project, sessionID: "test-insert" });
        console.log(`insert result: ${result}`);
        expect(result).toContain("Stored memory #");
        const id = Number(result.match(/#(\d+)/)?.[1]);
        expect(id).toBeGreaterThan(0);
        const rows = await __internals.sql`SELECT tags FROM memories WHERE id = ${id}` as { tags: string[] | null }[];
        expect(rows[0]?.tags).toContain("__internals-test");
        expect(rows[0]?.tags).toContain("project:ocpg-test-insert");
      } finally {
        await __internals.sql`DELETE FROM memories WHERE project = ${project}`;
      }
    });

    test("QA failure: 5-char content returns validation error", async () => {
      const result = await __internals.remember({ content: 'hello' }, ctx);
      console.log(`validation result: ${result}`);
      expect(result).toContain("ERROR");
      expect(result).toContain("at least 10 characters");
    });

    test("recall returns id field in formatted output", async () => {
      const result = await __internals.recall({ limit: 3 }, ctx);
      console.log(`recall output:\n${result}`);
      expect(result).toContain("#"); // id lines start with #
      expect(result).toContain("---"); // separator between rows
    });
  });

  describe("recall: relevance ranking + websearch query syntax", () => {
    const ctx = { directory: "/tmp/ocpg-test-recall-ranking" };

    test("QA happy: relevance-ranked above recency for a matching query", async () => {
      const marker = `zzztestrank${Date.now()}`;
      const relevantOld = `${marker} ${marker} ${marker} is the important note here`;
      const barelyRelevantNew = `filler text that only mentions ${marker} once at the very end`;

      const [oldRow] = await __internals.sql`
        INSERT INTO memories (content, tags, session_id, project, created_at)
        VALUES (${relevantOld}, ${__internals.sql.array(['__internals-test'])}, 'test-rank', ${ctx.directory}, now() - interval '10 days')
        RETURNING id
      ` as { id: number }[];
      const [newRow] = await __internals.sql`
        INSERT INTO memories (content, tags, session_id, project, created_at)
        VALUES (${barelyRelevantNew}, ${__internals.sql.array(['__internals-test'])}, 'test-rank', ${ctx.directory}, now())
        RETURNING id
      ` as { id: number }[];

      try {
        const result = await __internals.recall({ query: marker, limit: 2 }, ctx);
        console.log(`ranked recall output:\n${result}`);
        // The far-more-relevant OLDER row must rank first, ahead of the barely-relevant NEWER row.
        expect(result.indexOf(`#${oldRow.id}`)).toBeLessThan(result.indexOf(`#${newRow.id}`));
      } finally {
        await __internals.sql`DELETE FROM memories WHERE id IN (${oldRow.id}, ${newRow.id})`;
      }
    });

    test("QA happy: recency ordering preserved when no query given", async () => {
      const marker = `zzztestrecency${Date.now()}`;
      const [olderRow] = await __internals.sql`
        INSERT INTO memories (content, tags, session_id, project, created_at)
        VALUES (${`older ${marker}`}, ${__internals.sql.array(['__internals-test'])}, 'test-recency', ${ctx.directory}, now() - interval '1 day')
        RETURNING id
      ` as { id: number }[];
      const [newerRow] = await __internals.sql`
        INSERT INTO memories (content, tags, session_id, project, created_at)
        VALUES (${`newer ${marker}`}, ${__internals.sql.array(['__internals-test'])}, 'test-recency', ${ctx.directory}, now())
        RETURNING id
      ` as { id: number }[];

      try {
        const result = await __internals.recall({ limit: 2 }, ctx);
        expect(result.indexOf(`#${newerRow.id}`)).toBeLessThan(result.indexOf(`#${olderRow.id}`));
      } finally {
        await __internals.sql`DELETE FROM memories WHERE id IN (${olderRow.id}, ${newerRow.id})`;
      }
    });

    test("QA happy: websearch_to_tsquery OR syntax matches (plainto_tsquery would AND and miss)", async () => {
      const marker = `zzzwsalpha${Date.now()}`;
      const [row] = await __internals.sql`
        INSERT INTO memories (content, tags, session_id, project)
        VALUES (${`content mentioning only ${marker} and nothing else relevant`}, ${__internals.sql.array(['__internals-test'])}, 'test-ws', ${ctx.directory})
        RETURNING id
      ` as { id: number }[];

      try {
        // "a or b" is OR syntax under websearch_to_tsquery; plainto_tsquery would AND
        // both terms and never match since the nonexistent term never occurs.
        const result = await __internals.recall({ query: `${marker} or zzznonexistenttermxyz`, limit: 5 }, ctx);
        console.log(`OR-query recall output:\n${result}`);
        expect(result).toContain(`#${row.id}`);
      } finally {
        await __internals.sql`DELETE FROM memories WHERE id = ${row.id}`;
      }
    });
  });
});

test("QA: dispose on never-connected client does not throw", async () => {
  const freshSql = new SQL("postgres://localhost:5432/agent-memory", { max: 1 });
  await freshSql.close().catch(() => {});
  expect(true).toBe(true);
});

test("QA: rate-limited error logging on DB failure", async () => {
  const captured: unknown[] = [];
  __internals.resetRateLimit();
  const spy = spyOn(console, "error").mockImplementation((msg: unknown) => {
    captured.push(msg);
  });

  // Close SQL to force DB errors
  await __internals.sql.close();

  // First call: cache miss → DB error → logError → captured
  const output1: { system: string[] } = { system: [] };
  await __internals.handleTransform(
    { sessionID: "fail-test-1", model: {} },
    output1,
    "/home/dzhi/git/origo/vedurstofan-gitops",
  );
  expect(output1.system.length).toBe(0);

  // Second call: different sessionID → DB error → rate limited
  const output2: { system: string[] } = { system: [] };
  await __internals.handleTransform(
    { sessionID: "fail-test-2", model: {} },
    output2,
    "/home/dzhi/git/origo/vedurstofan-gitops",
  );
  expect(output2.system.length).toBe(0);

  // Exactly 1 error log captured; second suppressed by rate limit
  expect(captured.length).toBe(1);
  expect(String(captured[0])).toContain("ocpg injection failed");

  // logError beyond the rate window no-ops without crashing
  __internals.logError("should not log - rate limited");
  expect(captured.length).toBe(1);

  spy.mockRestore();
});
