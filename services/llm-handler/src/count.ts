// POST /v1/count (08-llm-handlers.md section 5): a budget-awareness
// estimate, never an exact provider token count -- the same chars/4
// heuristic and "always labeled estimate" posture apps/shell/src/lib/
// prompts.ts's estimateTokenCount already uses for Prompt Organizer (05-d
// section 9, rank 2). Deliberately duplicated rather than imported: that
// file's own header comment already documents why a consumer of this
// heuristic keeps its own copy instead of pulling it through
// packages/llm's index.ts barrel (its unconditional re-export of the three
// provider drivers drags @anthropic-ai/sdk/@google/genai/openai along with
// it -- a bundle-budget problem for a browser, and pure unnecessary weight
// for a route this small in a Node service). No live provider call: the
// route answers from the request body alone, which is what keeps its own
// 50 ms p95 budget trivially met.

import type { Message, MessagePart } from "@hyperbolic/llm";

function partText(part: MessagePart): string {
  if (part.type === "text") {
    return part.text;
  }
  if (part.type === "tool_use") {
    return JSON.stringify(part.input);
  }
  // tool_result
  return typeof part.content === "string" ? part.content : part.content.map((textPart) => textPart.text).join("");
}

function messageText(message: Message): string {
  if (typeof message.content === "string") {
    return message.content;
  }
  return message.content.map(partText).join("");
}

/** chars/4 heuristic over every message's flattened text, always ceil'd so
 * a non-empty message never estimates to zero tokens. */
export function estimateMessagesTokens(messages: Message[]): number {
  const totalChars = messages.reduce((sum, message) => sum + messageText(message).length, 0);
  return Math.ceil(totalChars / 4);
}
