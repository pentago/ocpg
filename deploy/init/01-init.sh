#!/bin/bash
# Runs once on first boot (docker-entrypoint-initdb.d) — the postgres image
# already created the database named by POSTGRES_DB (from .env); this adds the
# `memories` table the ocpg plugin expects. Fresh data dir only.
set -e

psql -v ON_ERROR_STOP=1 -U "$POSTGRES_USER" -d "$POSTGRES_DB" <<-'EOSQL'
	CREATE TABLE memories (
	  id            serial PRIMARY KEY,
	  content       text        NOT NULL,
	  tags          text[]      NOT NULL DEFAULT '{}',
	  session_id    text,
	  project       text,
	  source_host   text,
	  created_at    timestamptz DEFAULT now(),
	  search_vector tsvector GENERATED ALWAYS AS (to_tsvector('english', content)) STORED
	);
	CREATE INDEX idx_memories_search ON memories USING gin (search_vector);
	CREATE INDEX idx_memories_tags   ON memories USING gin (tags);
EOSQL

echo "ocpg: created table memories in database $POSTGRES_DB"
