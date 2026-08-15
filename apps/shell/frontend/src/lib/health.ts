// Generic liveness check for a DeployableUnit (see units.ts). Distinct from
// lib/acc.ts's useAccStatus: this hook only ever needs ok/unreachable (a
// boolean-shaped question -- "is this route up"), while the /acc card also
// needs the parsed body (tier/weekText/stopped). Both hit the same ACC URL
// on mount; the minor duplicate request this causes when both the ACC row
// and the ACC card are visible on the same page is a deliberate, cheap
// simplification (each fires once on mount, no polling) rather than
// threading shared state across two otherwise-independent surfaces.
import { useEffect, useState } from "react";
import type { DeployableUnit } from "./units";

export type UnitHealthStatus = "self" | "checking" | "ok" | "unreachable" | "manual";

export interface UnitHealthState {
  status: UnitHealthStatus;
  retry: () => void;
}

const DEFAULT_TIMEOUT_MS = 4000;

function initialStatus(unit: DeployableUnit): UnitHealthStatus {
  if (unit.health.kind === "self") return "self";
  if (unit.health.kind === "command") return "manual";
  return "checking";
}

export function useUnitHealth(unit: DeployableUnit, timeoutMs: number = DEFAULT_TIMEOUT_MS): UnitHealthState {
  const [status, setStatus] = useState<UnitHealthStatus>(() => initialStatus(unit));
  const [nonce, setNonce] = useState(0);

  useEffect(() => {
    if (unit.health.kind !== "http") {
      setStatus(initialStatus(unit));
      return;
    }
    const url = unit.health.url;
    let cancelled = false;
    setStatus("checking");
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);

    fetch(url, { signal: controller.signal })
      .then((res) => {
        if (!cancelled) setStatus(res.ok ? "ok" : "unreachable");
      })
      .catch(() => {
        if (!cancelled) setStatus("unreachable");
      })
      .finally(() => clearTimeout(timer));

    return () => {
      cancelled = true;
      controller.abort();
      clearTimeout(timer);
    };
    // `unit` is a stable reference from the static DEPLOYABLE_UNITS array,
    // so identity comparison is fine here and re-fetches only on an
    // explicit retry (nonce) or an explicit timeout override.
  }, [unit, nonce, timeoutMs]);

  return { status, retry: () => setNonce((n) => n + 1) };
}
