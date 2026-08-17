// Type declarations for contract.mjs -- this package ships as plain JS (no
// runtime TypeScript involved), but services/broker/ (issue #185) is the
// first TypeScript consumer, and `tsc --strict` cannot infer a shape for a
// bare .mjs import. Kept in lockstep with contract.mjs by hand: this package
// has no build step that could generate it automatically, and the shapes
// are small and stable (the same reason contract.mjs itself gives for being
// "shape-only": it does not decide policy, only whether input is
// well-formed enough to evaluate at all).

export declare const REQUIRED_REQUEST_FIELDS: readonly string[];

export interface ValidationResult {
  ok: boolean;
  errors: string[];
}

export interface PolicyEntry {
  allowedHosts?: string[];
  vaultKeys?: string[];
  maxUsdPerDay?: number | null;
}

export type PolicyDocument = Record<string, PolicyEntry>;

export declare function validateRequest(request: unknown): ValidationResult;
export declare function validatePolicyEntry(entry: unknown): ValidationResult;
export declare function validatePolicyDocument(doc: unknown): ValidationResult;
export declare function isKnownCaller(callerId: string, policyDocument: PolicyDocument): boolean;
