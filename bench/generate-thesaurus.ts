// Regenerates bench/thesaurus/bench_synonyms.ths from PARAPHRASES in
// config.ts. The .ths file is a generated artifact checked into the repo
// (Postgres reads dictionary files from its tsearch_data directory at DDL
// time, not from an arbitrary path), so it must be re-generated whenever
// PARAPHRASES changes:
//
//   bun bench/generate-thesaurus.ts
//
// After that, copy it into the Postgres server's tsearch_data directory and
// regenerate the bench DBs - see bench/README.md. run.ts fails the whole
// bench run if this file drifts from PARAPHRASES.
import { mkdirSync, writeFileSync } from "node:fs";
import { PARAPHRASES, thesaurusContent } from "./config.ts";

mkdirSync(new URL("./thesaurus/", import.meta.url), { recursive: true });
writeFileSync(new URL("./thesaurus/bench_synonyms.ths", import.meta.url), thesaurusContent());
console.log(`Wrote ${Object.keys(PARAPHRASES).length} thesaurus rules to bench/thesaurus/bench_synonyms.ths`);
