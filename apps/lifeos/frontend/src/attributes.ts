// Entity attributes are free-form JSON (`Record<string, unknown>`), so every
// read is a narrowing: show what is really there, never coerce or guess.

export type Attributes = Record<string, unknown>;

export const asString = (value: unknown) =>
  typeof value === "string" ? value : undefined;

export const asIds = (value: unknown): string[] =>
  Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string")
    : [];

/** The briefing's Monday utility-gate status (ADR 019 rule 9): counts and a
 * verdict, inline in the attributes rather than cited ids. */
export type Gate = { weeks: number[]; met: boolean };

export const asGate = (value: unknown): Gate | undefined => {
  if (typeof value !== "object" || value === null) return undefined;
  const { weeks, met } = value as { weeks?: unknown; met?: unknown };
  return Array.isArray(weeks) && typeof met === "boolean"
    ? { weeks: weeks.filter((w): w is number => typeof w === "number"), met }
    : undefined;
};
