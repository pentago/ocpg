#!/bin/bash
# Runs once on first boot (docker-entrypoint-initdb.d) - the postgres image
# already created the database named by POSTGRES_DB (from .env); this adds the
# `memories` table the ocpg plugin expects. Fresh data dir only.
set -e

psql -v ON_ERROR_STOP=1 -U "$POSTGRES_USER" -d "$POSTGRES_DB" <<-'EOSQL'
	-- Trigram similarity backs memory_remember's dedup-on-write. Without it the
	-- plugin falls back to a weaker full-text rule that misses near-duplicates.
	CREATE EXTENSION IF NOT EXISTS pg_trgm;

	-- pgvector backs the embedding half of hybrid retrieval (bge-m3 via Ollama,
	-- 1024 dims - the column dimension is tied to the embedding model).
	CREATE EXTENSION IF NOT EXISTS vector;

	CREATE TABLE memories (
	  id            serial PRIMARY KEY,
	  content       text        NOT NULL,
	  tags          text[]      NOT NULL DEFAULT '{}',
	  session_id    text,
	  project       text,
	  created_at    timestamptz DEFAULT now(),
	  memory_type   text        NOT NULL DEFAULT 'project_fact',
	  access_count  integer     NOT NULL DEFAULT 0,
	  last_accessed_at timestamptz,
	  updated_at    timestamptz,
	  search_vector tsvector GENERATED ALWAYS AS (to_tsvector('english', content)) STORED,
	  embedding     vector(1024),
	  CONSTRAINT memories_type_check
	    CHECK (memory_type IN ('stack_fact', 'project_fact', 'episodic'))
	);
	CREATE INDEX idx_memories_search ON memories USING gin (search_vector);
	CREATE INDEX idx_memories_tags   ON memories USING gin (tags);
	CREATE INDEX idx_memories_project_created ON memories (project, created_at DESC);

	-- HNSW index for the nearest-neighbor half of hybrid retrieval (cosine).
	CREATE INDEX idx_memories_embedding ON memories USING hnsw (embedding vector_cosine_ops);

	-- Trigram content index: accelerates memory_consolidate's near-duplicate
	-- self-join (content % content). Without it the join is O(n^2) similarity
	-- scans - fine for hundreds of rows, slow for tens of thousands.
	CREATE INDEX idx_memories_trgm ON memories USING gin (content gin_trgm_ops);

	-- Cross-session recall signal: which sessions have independently recalled
	-- a memory (not "how many times", which is access_count - see ocpg.ts's
	-- crossSessionBoost comment for why that distinction matters). The
	-- PRIMARY KEY makes repeated recalls within one session count once.
	CREATE TABLE memory_recalls (
	  memory_id  integer NOT NULL REFERENCES memories(id) ON DELETE CASCADE,
	  session_id text NOT NULL,
	  recalled_at timestamptz NOT NULL DEFAULT now(),
	  PRIMARY KEY (memory_id, session_id)
	);
EOSQL

echo "ocpg: created table memories in database $POSTGRES_DB"
