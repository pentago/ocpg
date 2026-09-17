#!/bin/bash
# Runs once on first boot (docker-entrypoint-initdb.d) - the postgres image
# already created the database named by POSTGRES_DB (from .env); this adds the
# `memories` table the ocpg plugin expects. Fresh data dir only.
set -e

psql -v ON_ERROR_STOP=1 -U "$POSTGRES_USER" -d "$POSTGRES_DB" <<-'EOSQL'
	-- Trigram similarity backs memory_remember's dedup-on-write. Without it the
	-- plugin falls back to a weaker full-text rule that misses near-duplicates.
	CREATE EXTENSION IF NOT EXISTS pg_trgm;

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
	  CONSTRAINT memories_type_check
	    CHECK (memory_type IN ('preference', 'project_fact', 'episodic'))
	);
	CREATE INDEX idx_memories_search ON memories USING gin (search_vector);
	CREATE INDEX idx_memories_tags   ON memories USING gin (tags);
	CREATE INDEX idx_memories_project_created ON memories (project, created_at DESC);
EOSQL

echo "ocpg: created table memories in database $POSTGRES_DB"
