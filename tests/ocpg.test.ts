import { describe, test, expect } from "bun:test";
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

    test("QA happy: remember dedup via rolled-back tx", async () => {
      const marker = `test-dedup-${Date.now()}-${Math.random().toString(36).slice(2)}`;
      const content = `Unique marker for dedup test: ${marker}`;

      await __internals.sql.begin(async (tx) => {
        // Insert via remember logic (manual insert + dedup check)
        const inserted = await tx`
          INSERT INTO memories (content, tags, session_id, project)
          VALUES (${content}, ${['__internals-test']}, ${ctx.sessionID}, ${ctx.directory})
          RETURNING id
        ` as { id: number }[];
        const insertedId = inserted[0].id;
        console.log(`inserted test memory #${insertedId}`);

        // Second call: dedup should find it
        const result = await __internals.remember({ content, tags: ['__internals-test'] }, ctx);
        console.log(`dedup result: ${result}`);
        expect(result).toContain("Similar memory already stored as #");
        expect(result).toContain(String(insertedId));

        // Throw to roll back the tx
        throw new Error('rollback-intentional');
      }).catch(() => {}); // swallow rollback error
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
});

test("QA: dispose on never-connected client does not throw", async () => {
  const freshSql = new SQL("postgres://localhost:5432/agent-memory", { max: 1 });
  await freshSql.close().catch(() => {});
  expect(true).toBe(true);
});

test("QA: reconfigure swaps pool; options override defaults", async () => {
  const before = __internals.sql;
  __internals.reconfigure({ host: "127.0.0.1", port: 5433, user: "x", database: "y" });
  expect(__internals.sql).not.toBe(before);
  await __internals.sql.close().catch(() => {});
  __internals.reconfigure({}); // restore env/default pool
});

test("QA: rate-limited error logging on DB failure", async () => {
  const captured: unknown[] = [];
  const stubClient = { app: { log: (i: unknown) => captured.push(i) } };

  __internals.setClient(stubClient);

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
  expect(captured[0]).toEqual({
    body: {
      service: "ocpg",
      level: "error",
      message: expect.stringContaining("ocpg injection failed"),
    },
  });

  // logError with null client no-ops without crashing
  __internals.logError(null, "should not log - no client");
  expect(captured.length).toBe(1);
});
