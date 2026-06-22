import type { ContentType, PushReviewInput } from '../shared/types.js';

function buildCommonContext(input: PushReviewInput): string {
  const parts: string[] = [`Title: ${input.title}`];
  if (input.description) parts.push(`Description:\n${input.description}`);
  if (input.diff) parts.push(`Diff:\n\`\`\`\n${input.diff}\n\`\`\``);
  if (input.tags?.length) parts.push(`Tags: ${input.tags.join(', ')}`);
  if (input.selfAssessedRisk) {
    parts.push(`Self-assessed risk: ${input.selfAssessedRisk}`);
  }
  return parts.join('\n\n');
}
const OUTPUT_SPEC = `Output a JSON object (and ONLY the JSON, no markdown, no preamble) with this exact shape:
{
  "riskLevel": "L1" | "L2" | "L3",
  "summary": "1-2 sentence assessment",
  "findings": [
    {
      "severity": "low" | "medium" | "high" | "critical",
      "category": "<short category name>",
      "description": "<what is the issue>",
      "location": "<optional file:line or section reference>",
      "suggestion": "<optional fix suggestion>"
    }
  ]
}

Rules:
- Be specific and actionable. No filler phrases.
- Prefer fewer high-signal findings over many low-value ones.
- riskLevel L1 = safe/trivial, L2 = needs review, L3 = high risk / needs changes.`;

const REQUIREMENT_PROMPT = `You are a senior product reviewer. Review the following REQUIREMENT for completeness, ambiguity, missing edge cases, and unverifiable assertions. Don't accept vague terms like "etc." or "should work" — flag them.

${OUTPUT_SPEC}
`;

const PLAN_PROMPT = `You are a senior architect reviewing a technical PLAN. Focus on: feasibility (will this actually work?), missing dependencies, side effects on existing systems, rollback strategy, and risks the author under-estimated. Look for one-way doors disguised as two-way doors.

${OUTPUT_SPEC}
`;

const CODE_PROMPT = `You are a senior code reviewer. Review the following CODE DIFF for correctness, security, performance, style, and missing tests. Don't restate what the code obviously does — focus on what could break, leak, or surprise.

${OUTPUT_SPEC}
`;

const PROMPTS: Record<ContentType, string> = {
  requirement: REQUIREMENT_PROMPT,
  plan: PLAN_PROMPT,
  code: CODE_PROMPT,
};

export function buildPrompt(input: PushReviewInput): string {
  const contentType: ContentType = input.contentType ?? 'code';
  const header = PROMPTS[contentType];
  return `${header}\n\n---\n\n${buildCommonContext(input)}\n`;
}