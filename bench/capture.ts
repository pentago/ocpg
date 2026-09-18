// Gate 2 for compaction capture: runs the production extraction path
// (renderTranscript + buildCapturePrompt + judge) against REAL past opencode
// sessions and prints what it would have stored. WRITES NOTHING - this is a
// dress rehearsal for manual quality review, the ship decision is a human
// call on this output.
//
// bun bench/capture.ts [sessionID ...]
//
// Sessions are fetched from the local opencode server via `opencode api`.
// With no arguments, a hand-picked mix of substantive and trivial sessions is
// used: the substantive ones must produce a few GOOD facts, the trivial one
// must produce NONE (storing nothing is a correct outcome).
import ocpg from "../ocpg.ts";

const { __internals } = ocpg;

const DEFAULT_SESSIONS = [
  "ses_f4b745f0cffezwHAzmPPXMYQpw", // hybrid search implementation (substantive)
  "ses_f53f3c486ffeWi3q2i0iwIc6fa", // mem0 aggressiveness discussion (decision-heavy)
  "ses_f500f9e6effeY9zOPNEHP3W00a", // zshenv update + service restart (config task)
  "ses_f55cb783affesESoSo50j8RbJp", // "message Branko" (trivial - must extract nothing)
];

type ApiMessage = {
  type?: string;
  text?: string;
  content?: { type?: string; text?: string; name?: string }[];
};

async function fetchTranscript(sessionID: string): Promise<{ role: string; content: { type: string; text?: string; name?: string }[] }[]> {
  // Through a temp file, not a pipe: Bun.spawnSync truncates captured stdout
  // at ~950KB regardless of maxBuffer, and long sessions exceed that.
  const tmp = `/tmp/opencode/ocpg-capture-${sessionID}.json`;
  const proc = Bun.spawnSync(["sh", "-c", `opencode api get /api/session/${sessionID}/context > ${tmp}`]);
  if (proc.exitCode !== 0) throw new Error(`opencode api failed: ${proc.stderr.toString()}`);
  const raw = JSON.parse(await Bun.file(tmp).text()) as ApiMessage[] | { data: ApiMessage[] };
  const messages = Array.isArray(raw) ? raw : raw.data;
  const out: { role: string; content: { type: string; text?: string; name?: string }[] }[] = [];
  for (const m of messages) {
    if (m.type !== "user" && m.type !== "assistant") continue;
    if (typeof m.text === "string") {
      out.push({ role: m.type, content: [{ type: "text", text: m.text }] });
    } else if (Array.isArray(m.content)) {
      // Reasoning parts are dropped: chain-of-thought is not session content.
      const content = m.content.flatMap((p) =>
        p.type === "text" || p.type === "tool-call" ? [{ type: p.type, text: p.text, name: p.name }] : [],
      );
      out.push({ role: m.type, content });
    }
  }
  return out;
}

const ids = process.argv.slice(2).length > 0 ? process.argv.slice(2) : DEFAULT_SESSIONS;

for (const id of ids) {
  console.log(`\n${"=".repeat(72)}\nSESSION ${id}`);
  let messages: Awaited<ReturnType<typeof fetchTranscript>>;
  try {
    messages = await fetchTranscript(id);
  } catch (e) {
    console.log(`  fetch failed: ${e instanceof Error ? e.message : e}`);
    continue;
  }
  const transcript = __internals.renderTranscript(messages);
  console.log(`  messages: ${messages.length}, transcript: ${transcript.length} chars`);
  if (transcript.length < 500) {
    console.log("  (below the 500-char floor - production would skip)");
    continue;
  }
  const raw = await __internals.judgeRaw(__internals.buildCapturePrompt(transcript));
  if (!raw) {
    console.log("  JUDGE FAILED (production would skip capture for this compaction)");
    continue;
  }
  const facts = __internals.parseExtractedFacts(raw);
  if (facts.length === 0) {
    console.log("  -> no durable facts (nothing would be stored)");
    continue;
  }
  for (const [i, f] of facts.entries()) {
    console.log(`  fact ${i + 1} [${f.type}] tags=[${f.tags.join(", ")} + auto]`);
    console.log(`    ${f.content}`);
  }
}

await __internals.sql.close({ timeout: 0 }).catch(() => {});
