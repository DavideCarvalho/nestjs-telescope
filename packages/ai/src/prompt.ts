// packages/ai/src/prompt.ts
import type { DiagnoseContext } from '@dudousxd/nestjs-telescope';

/**
 * Cap on stack frames sent to the model. The TOP frames carry the throw site and
 * the immediate callers — the highest-signal part for root-causing — while a deep
 * tail mostly burns input tokens. Clipping keeps the prompt bounded and cheap.
 */
const STACK_FRAME_LIMIT = 25;

/**
 * The system prompt. Frames the model as a senior engineer triaging a PRODUCTION
 * exception and pins the OUTPUT CONTRACT (markdown, four fixed sections, bounded
 * length) so the rendered dashboard block and the Slack note stay consistent and
 * scannable. We ask for confidence explicitly so an operator can calibrate trust
 * — a low-confidence guess is still useful but should be read as such.
 */
export const SYSTEM_PROMPT = [
  'You are a senior backend engineer triaging a production exception for a teammate.',
  'You are given an exception (class, message, stack), the HTTP route or page it came',
  'from, and the SQL queries that ran in the same request. The query values are',
  'redacted; reason about shapes and code paths, not specific data.',
  '',
  'Respond in GitHub-flavored markdown with EXACTLY these four sections, in order:',
  '',
  '## Probable root cause',
  'Two to three sentences. Be specific about WHAT failed and WHY, grounded in the',
  'message and stack. Do not restate the exception verbatim.',
  '',
  '## Where to look',
  'Point at the most relevant stack frames (file + function) and, when the queries',
  'are implicated, the query that matters. Use a short bullet list.',
  '',
  '## Suggested fix',
  'A concrete, actionable change. One short paragraph or a few bullets. Prefer the',
  'smallest correct fix; mention a guard/validation if the input looks malformed.',
  '',
  '## Confidence',
  'One word — High, Medium, or Low — then a brief clause on what would raise it.',
  '',
  'Keep the whole response under ~400 words. Do not invent file paths or framework',
  'details that are not supported by the stack. If the stack is missing, say so and',
  'reason from the message and route alone.',
].join('\n');

/**
 * Assemble the USER message from a {@link DiagnoseContext}. Plain labelled
 * sections (not JSON) read better for an LLM and keep the redacted, SQL-only
 * query list explicit. Absent fields are omitted rather than rendered as `null`,
 * so the model isn't nudged to comment on missing data.
 */
export function buildUserPrompt(context: DiagnoseContext): string {
  const lines: string[] = [];
  lines.push(`Exception: ${context.exceptionClass}: ${context.message}`);
  lines.push(`Source: ${context.client ? 'browser (client-side)' : 'server'}`);

  if (context.client) {
    if (context.url !== null) lines.push(`Page URL: ${context.url}`);
    if (context.userAgent !== null) lines.push(`User agent: ${context.userAgent}`);
  } else if (context.request !== null) {
    const { method, route, statusCode, durationMs } = context.request;
    const routeLine = [method, route].filter((part) => part !== null).join(' ');
    if (routeLine !== '') lines.push(`Route: ${routeLine}`);
    if (statusCode !== null) lines.push(`Status: ${statusCode}`);
    if (durationMs !== null) lines.push(`Duration: ${durationMs} ms`);
  }

  if (context.occurrenceCount > 1) {
    lines.push(`Occurrences (last window): ${context.occurrenceCount}`);
  }

  if (context.stack !== null && context.stack.trim() !== '') {
    lines.push('', 'Stack:', clipStack(context.stack));
  } else {
    lines.push('', 'Stack: (none captured)');
  }

  if (context.recentQueries.length > 0) {
    lines.push('', 'Recent queries in this request (SQL only, values redacted):');
    for (const sql of context.recentQueries) {
      lines.push(`- ${sql}`);
    }
  }

  return lines.join('\n');
}

/** Keep at most the first {@link STACK_FRAME_LIMIT} lines of the stack. */
function clipStack(stack: string): string {
  return stack.split('\n').slice(0, STACK_FRAME_LIMIT).join('\n');
}

export { STACK_FRAME_LIMIT };
