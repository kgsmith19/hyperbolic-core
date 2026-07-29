// Entity attributes are free-form JSON (`Record<string, unknown>`), so every
// read is a narrowing: show what is really there, never coerce or guess.

export type Attributes = Record<string, unknown>;

export const asString = (value: unknown) =>
  typeof value === "string" ? value : undefined;

export const asIds = (value: unknown): string[] =>
  Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string")
    : [];
