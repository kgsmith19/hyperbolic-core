// A small generic version of the load/error/retry shape src/lib/registry.ts's
// useRegisteredTools and src/lib/acc.ts's useAccStatus each already
// hand-roll for their own one call site. m3-07 needs the identical shape
// twice (the ideas list, the single-idea editor load) -- two real call
// sites is where a shared version stops being premature.
import { useEffect, useState } from "react";

export interface AsyncState<T> {
  status: "loading" | "ready" | "error";
  data: T | null;
  errorMessage: string | null;
  retry: () => void;
}

function messageFor(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function useAsync<T>(load: () => Promise<T>, deps: readonly unknown[] = []): AsyncState<T> {
  const [data, setData] = useState<T | null>(null);
  const [status, setStatus] = useState<"loading" | "ready" | "error">("loading");
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [nonce, setNonce] = useState(0);

  useEffect(() => {
    let cancelled = false;
    setStatus("loading");
    setErrorMessage(null);

    load()
      .then((next) => {
        if (cancelled) return;
        setData(next);
        setStatus("ready");
      })
      .catch((error: unknown) => {
        if (cancelled) return;
        setErrorMessage(messageFor(error));
        setStatus("error");
      });

    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- `load` and
    // `deps` are the caller's own explicit dependency contract, matching
    // useRegisteredTools' identical suppression for the same reason.
  }, [nonce, ...deps]);

  return { status, data, errorMessage, retry: () => setNonce((n) => n + 1) };
}
