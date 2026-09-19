// Generates synthetic bench databases with known relevance ground truth.
//
// bun bench/generate.ts [--sizes 500,5000,50000] [--seed 42]
//
// Creates `agent-memory-bench-<size>` (dropping any previous version). Schema
// mirrors deploy/init/01-init.sh; if the init schema gains columns, this DDL
// must follow - CI bootstraps from the real script, this file must not drift.
// Requires the OCPG_* user to hold CREATEDB privileges on the local server.
import { SQL } from "bun";
import {
  FILLERS,
  PROJECTS,
  SIZES,
  TEMPLATES,
  TOPICS,
  benchDbName,
  makeSql,
  pick,
  rng,
} from "./config.ts";

const args = process.argv.slice(2);
const sizeArgIdx = args.indexOf("--sizes");
const sizes = sizeArgIdx >= 0 ? args[sizeArgIdx + 1].split(",").map(Number) : [...SIZES];
const seedArgIdx = args.indexOf("--seed");
const seed = seedArgIdx >= 0 ? Number(args[seedArgIdx + 1]) : 42;

const DDL = `
CREATE EXTENSION IF NOT EXISTS pg_trgm;
CREATE TABLE memories (
  id                 serial PRIMARY KEY,
  content            text        NOT NULL,
  tags               text[]      NOT NULL DEFAULT '{}',
  session_id         text,
  project            text,
  created_at         timestamptz DEFAULT now(),
  memory_type        text        NOT NULL DEFAULT 'project_fact',
  access_count       integer     NOT NULL DEFAULT 0,
  last_accessed_at   timestamptz,
  updated_at         timestamptz,
  search_vector      tsvector GENERATED ALWAYS AS (to_tsvector('english', content)) STORED,
  CONSTRAINT memories_type_check
    CHECK (memory_type IN ('project_fact', 'episodic'))
);
CREATE INDEX idx_memories_search ON memories USING gin (search_vector);
CREATE INDEX idx_memories_tags   ON memories USING gin (tags);
CREATE INDEX idx_memories_project_created ON memories (project, created_at DESC);
`;

// admin = the connection that creates/drops databases.
const admin = new SQL(makeSql("postgres"));

for (const size of sizes) {
  const dbname = benchDbName(size);
  await admin`DROP DATABASE IF EXISTS ${admin(dbname)}`;
  await admin`CREATE DATABASE ${admin(dbname)}`;
  const db = new SQL(makeSql(dbname));
  try {
    await db.unsafe(DDL);

    const rand = rng(seed + size);
    const rows: Array<[string, string[], string, number]> = []; // content, tags, project, daysAgo

    // ~25% filler: memories with no topic signal at all.
    const fillerCount = Math.round(size * 0.25);
    const topicCount = size - fillerCount;
    const memoriesPerTopic = Math.max(1, Math.floor(topicCount / TOPICS.length));

    TOPICS.forEach((topic, tIdx) => {
      for (let i = 0; i < memoriesPerTopic; i++) {
        // Two templates per memory, each sampling the topic vocab: the
        // per-topic word union is the query source, so query terms are
        // guaranteed present in the topic's memories.
        const text = [0, 1]
          .map(() => pick(rand, TEMPLATES).replaceAll("{s}", () => pick(rand, topic.words)).replaceAll("{f}", pick(rand, FILLERS)))
          .join(" ");
        const tags = [topic.subject, pick(rand, ["decision", "debug", "env", "workaround"])].slice(0, rand() < 0.7 ? 2 : 1);
        rows.push([text, tags, PROJECTS[tIdx % PROJECTS.length], Math.floor(rand() * 400)]);
      }
    });

    for (let i = 0; i < fillerCount; i++) {
      const text = `${pick(rand, FILLERS)} ${pick(rand, FILLERS)}: ${pick(rand, FILLERS)} ${pick(rand, FILLERS)} ${pick(rand, FILLERS)}.`;
      rows.push([`Filler note ${i} - ${text}`, [pick(rand, ["notes", "misc", "context"])], pick(rand, PROJECTS), Math.floor(rand() * 400)]);
    }

    // Shuffle so ids do not leak topic order (ranking must not depend on it).
    for (let i = rows.length - 1; i > 0; i--) {
      const j = Math.floor(rand() * (i + 1));
      [rows[i], rows[j]] = [rows[j], rows[i]];
    }

    const BATCH = 500;
    for (let b = 0; b < rows.length; b += BATCH) {
      await db.begin(async (tx) => {
        for (const [content, tags, project, daysAgo] of rows.slice(b, b + BATCH)) {
          await tx`
            INSERT INTO memories (content, tags, session_id, project, created_at, memory_type)
            VALUES (${content}, ${tx.array(tags, "text")}, 'bench', ${project}, now() - (${daysAgo} || ' days')::interval, 'project_fact')
          `;
        }
      });
    }

    console.log(`${dbname}: ${rows.length} memories, ${TOPICS.length} topics, ${PROJECTS.length} projects`);
  } finally {
    await db.close({ timeout: 0 }).catch(() => {});
  }
}

await admin.close({ timeout: 0 });
