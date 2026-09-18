// Shared bench harness: query-mix construction and scoring, used by both
// run.ts (lexical strategies) and embed.ts (pgvector strategies) so the two
// can never drift apart - identical seeds here mean identical query mixes.
import { PARAPHRASES, TOPICS, pick } from "./config.ts";

export type BenchRow = { id: number; content: string; project: string };
export type Case = { text: string; topicIdx: number; kind: "direct" | "paraphrase" };

export const sanitizeOr = (q: string): string => (q.toLowerCase().match(/[a-z0-9]+/g) ?? []).slice(0, 24).join(" | ");
export const sanitizeAnd = (q: string): string => (q.toLowerCase().match(/[a-z0-9]+/g) ?? []).slice(0, 24).join(" & ");

// Topic -> contents of memories containing at least one of the topic's words,
// restricted to the CALLING project: since all bench rows are project_fact and
// every strategy now filters to the calling project's project_fact rows, a
// cross-project row is not a reachable answer and must not count against
// recall.
export function buildTopicIds(rows: BenchRow[], project: string): Map<number, Set<string>> {
  const byTopic = new Map<number, Set<string>>();
  TOPICS.forEach((topic, tIdx) => {
    const set = new Set<string>();
    for (const row of rows) {
      if (row.project !== project) continue;
      const lower = row.content.toLowerCase();
      if (topic.words.some((w) => lower.includes(w.toLowerCase()))) set.add(row.content);
    }
    byTopic.set(tIdx, set);
  });
  return byTopic;
}

// Corpus vocabulary per topic: only words actually present in that topic's
// memories become query terms.
export function buildCorpusWords(rows: BenchRow[]): Map<number, string[]> {
  const out = new Map<number, string[]>();
  TOPICS.forEach((topic, tIdx) => {
    const words = topic.words.filter((w) => rows.some((r) => r.content.toLowerCase().includes(w.toLowerCase())));
    out.set(tIdx, words);
  });
  return out;
}

export function buildMix(rand: () => number, corpusWords: Map<number, string[]>, perMix: number): Case[] {
  const cases: Case[] = [];
  const paraTopics = TOPICS.map((t, i) => ({ t, i })).filter(({ t }) => t.words.some((w) => PARAPHRASES[w] !== undefined));
  for (let i = 0; i < perMix; i++) {
    const tIdx = Math.floor(rand() * TOPICS.length);
    const words = corpusWords.get(tIdx) ?? [];
    if (words.length < 2) continue;
    const sample = [...words].sort(() => rand() - 0.5).slice(0, Math.min(5, words.length));
    cases.push({ text: sample.join(" "), topicIdx: tIdx, kind: "direct" });
  }
  for (let i = 0; i < Math.round(perMix / 2); i++) {
    const { t, i: tIdx } = pick(rand, paraTopics);
    const mapped = t.words.filter((w) => PARAPHRASES[w] !== undefined).map((w) => PARAPHRASES[w]);
    cases.push({ text: mapped.join(" "), topicIdx: tIdx, kind: "paraphrase" });
  }
  return cases;
}

export function score(returned: Array<{ content: string }>, relevant: Set<string>): { recall: number; mrr: number; prec: number } | null {
  if (relevant.size === 0) return null;
  const k = returned.slice(0, 5);
  const hits = k.filter((r) => relevant.has(r.content)).length;
  const firstRank = k.findIndex((r) => relevant.has(r.content)) + 1;
  return {
    recall: hits / Math.min(5, relevant.size),
    mrr: firstRank > 0 ? 1 / firstRank : 0,
    prec: hits / 5,
  };
}
