import type { WorkJob } from "./work-job.ts";
import { validateWorkJob } from "./work-job.ts";

export interface WorkIntentCompilation {
  schema: "oneesama.work_intent.v1";
  decision: "job" | "not_a_command";
  matchedBy: "grammar" | "llm" | "none";
  query: string;
  job?: WorkJob;
  reason: string;
}

export interface WorkIntentCompilerOptions {
  surfaceId?: string;
  /** Optional LLM fallback for utterances the grammar cannot classify. */
  llmFallback?: (
    transcript: string,
  ) => Promise<{ decision: "job" | "not_a_command"; query: string }>;
}

// Leading command verbs only — a command is something you ask the assistant
// to DO now. Mid-sentence mentions ("我们下周再讨论搜索功能"), negations
// ("别查了"), and questions about the past ("你刚才查到什么") must NOT fire:
// a false action is worse than a miss (RFC P0.2).
const COMMAND_PATTERN =
  /^(?:(?:请|麻烦|帮我|帮忙|你去|你|去|来)\s*){0,3}(?:查一下|查查|查询|查|搜一下|搜索|搜搜|搜|找一下|找找|看一下|看看|调研|了解|search for|search|look up|find out|find|check out|check|research)\s*[:：,，]?\s*(.{2,})$/iu;

const TRAILING_NOISE = /(?:吧|呗|呢|吗|啊|呀|好吗|可以吗|谢谢|please|thanks)[.!?。！？\s]*$/iu;

// Verb-complement starts ("查到什么了") and noun-compound starts
// ("搜索结果看起来不对", "search results look wrong") mean the matched word
// was not used as a command verb — reject instead of guessing.
const QUERY_REJECT_PREFIX =
  /^(?:到|过|没|不|啥|什么|结果|功能|接口|历史|记录|引擎|框|栏|按钮|results?|features?|history|engine|bar|box|button)/iu;

function cleanQuery(raw: string) {
  return raw
    .replace(/^(?:一下|下|个)\s*/u, "")
    .replace(TRAILING_NOISE, "")
    .replace(/[.!?。！？]+$/u, "")
    .trim();
}

function significantTerm(query: string) {
  const tokens = query
    .split(/[\s,，;；:：、的了在和与或]+/u)
    .map((token) => token.trim())
    .filter((token) => token.length >= 2);
  tokens.sort((a, b) => b.length - a.length);
  return tokens[0] || query.slice(0, 12);
}

function buildJob(query: string, transcript: string, surfaceId: string): WorkJob | undefined {
  const validation = validateWorkJob({
    id: `job_intent_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`,
    surfaceId,
    intent: `Research and explain: ${query}`,
    constraints: [`original utterance: ${transcript}`],
    postConditions: [{ kind: "text_present", value: significantTerm(query) }],
    riskLevel: "read_only",
    source: "intent_compiler",
  });
  return validation.job;
}

/**
 * Compile a final transcript into a typed work job or `not_a_command`
 * (RFC P1.2/P1.3). The grammar pass is deterministic and testable offline;
 * the optional LLM fallback only sees utterances the grammar rejected, and
 * its output is constrained to the same two outcomes.
 */
export async function compileWorkIntent(
  transcript: string,
  options: WorkIntentCompilerOptions = {},
): Promise<WorkIntentCompilation> {
  const surfaceId = options.surfaceId || "kwwk-ax";
  const text = String(transcript || "").trim();
  if (!text) {
    return {
      schema: "oneesama.work_intent.v1",
      decision: "not_a_command",
      matchedBy: "none",
      query: "",
      reason: "empty_transcript",
    };
  }
  const match = text.match(COMMAND_PATTERN);
  if (match && !QUERY_REJECT_PREFIX.test(match[1].trim())) {
    const query = cleanQuery(match[1]);
    if (query.length >= 2) {
      return {
        schema: "oneesama.work_intent.v1",
        decision: "job",
        matchedBy: "grammar",
        query,
        job: buildJob(query, text, surfaceId),
        reason: "grammar_command_verb",
      };
    }
  }
  if (options.llmFallback) {
    const verdict = await options.llmFallback(text);
    if (verdict.decision === "job" && verdict.query.trim().length >= 2) {
      const query = cleanQuery(verdict.query);
      return {
        schema: "oneesama.work_intent.v1",
        decision: "job",
        matchedBy: "llm",
        query,
        job: buildJob(query, text, surfaceId),
        reason: "llm_fallback",
      };
    }
    return {
      schema: "oneesama.work_intent.v1",
      decision: "not_a_command",
      matchedBy: "llm",
      query: "",
      reason: "llm_fallback_rejected",
    };
  }
  return {
    schema: "oneesama.work_intent.v1",
    decision: "not_a_command",
    matchedBy: "none",
    query: "",
    reason: "no_command_verb",
  };
}
