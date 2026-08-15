/**
 * Message-part narrowing shared by the OpenAI and Gemini drivers, which both
 * previously carried an IDENTICAL copy of each function.
 *
 * (The Anthropic driver needs neither: its wire format takes structured
 * content blocks directly, so it maps parts rather than flattening them.)
 */
import type { MessagePart, TextPart } from "../types.ts";

/**
 * Flatten text content to a single string.
 *
 * Both providers accept only a plain string where this repo's message model
 * allows an array of text parts, so the parts are concatenated with no
 * separator -- they are contiguous pieces of one message, not a list.
 */
export function toPlainText(content: string | TextPart[]): string {
  return typeof content === "string" ? content : content.map((t) => t.text).join("");
}

/**
 * Type guard for the text arm of the MessagePart union, so `.filter()` narrows
 * to TextPart[] instead of leaving the caller with MessagePart[].
 */
export function isTextPart(part: MessagePart): part is Extract<MessagePart, { type: "text" }> {
  return part.type === "text";
}
