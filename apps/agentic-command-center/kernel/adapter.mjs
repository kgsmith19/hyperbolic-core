// Harness selection. The configured name maps to a module by CONVENTION
// (kernel/adapters/<name>.mjs), so no harness name exists anywhere in kernel
// code — swapping harnesses is one value in policy.json plus one new file.
// That is the whole point of this module; do not add a registry table.
//
// The name arrives from configuration, so it is validated as a bare slug
// before it becomes a module specifier: a name like "../../x" would otherwise
// import arbitrary code.
import { loadKernelPolicy } from "./policy.mjs";

export const ADAPTER_INTERFACE = ["id", "identity", "startTask", "sendStep", "readState", "stopTask"];

export function adapterSpecifier(name) {
  if (!/^[a-z0-9-]+$/.test(String(name ?? ""))) {
    throw new Error(`kernel: invalid harness name ${JSON.stringify(name)} — set policy.json kernel.harness to a slug matching /^[a-z0-9-]+$/`);
  }
  return `./adapters/${name}.mjs`;
}

export function assertAdapterShape(mod, name) {
  for (const member of ADAPTER_INTERFACE) {
    const want = member === "id" ? "string" : "function";
    if (typeof mod?.[member] !== want) {
      throw new Error(`kernel: adapter "${name}" does not implement ${member} (expected ${want})`);
    }
  }
}

// Fail closed: an unavailable harness is an error, never a fallback to a
// different one. A silent fallback would run the task on a harness the ledger
// then mislabels.
export async function resolveAdapter(name = loadKernelPolicy().harness) {
  const specifier = adapterSpecifier(name);
  let mod;
  try {
    mod = await import(specifier);
  } catch (e) {
    throw new Error(`kernel: harness "${name}" is not available (${e.message})`);
  }
  assertAdapterShape(mod, name);
  return mod;
}
