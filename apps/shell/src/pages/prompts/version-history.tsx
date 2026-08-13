// Version history + restore (05-d section 7: rollback restores a prior
// version as a NEW version, history is never rewritten). Loads lazily on
// first expand -- SPEC-0005's original panel.mjs behavior (a `{ once: true }`
// toggle listener) -- so a prompt nobody ever opens costs zero extra
// PostgREST calls.
import { useState } from "react";
import { Button, Spinner } from "@hyperbolic/ui";
import { listVersions, type Prompt, type PromptVersion } from "../../lib/prompts";

interface VersionHistoryProps {
  prompt: Prompt;
  onRestore: (body: string) => void;
  restoring: boolean;
}

function VersionHistory({ prompt, onRestore, restoring }: VersionHistoryProps) {
  const [open, setOpen] = useState(false);
  const [status, setStatus] = useState<"idle" | "loading" | "ready" | "error">("idle");
  const [versions, setVersions] = useState<PromptVersion[]>([]);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  async function handleToggle(event: React.SyntheticEvent<HTMLDetailsElement>) {
    const next = event.currentTarget.open;
    setOpen(next);
    if (!next || status !== "idle") return;
    setStatus("loading");
    try {
      const rows = await listVersions(prompt.id);
      setVersions(rows);
      setStatus("ready");
    } catch (err) {
      setErrorMessage(err instanceof Error ? err.message : "Failed to load version history.");
      setStatus("error");
    }
  }

  return (
    <details data-testid="version-history" open={open} onToggle={handleToggle}>
      <summary className="cursor-pointer text-sm font-medium text-text-secondary">Version history</summary>
      <div className="mt-2 flex flex-col gap-2">
        {status === "loading" && <Spinner />}
        {status === "error" && <p className="text-sm text-danger">{errorMessage}</p>}
        {status === "ready" && (
          <ul className="flex flex-col gap-2" data-testid="version-list">
            {versions.map((version) => {
              const isCurrent = version.body === prompt.body;
              return (
                <li key={version.versionNo} className="flex items-start justify-between gap-3 text-sm" data-testid="version-row">
                  <span className="min-w-0 flex-1 text-text-secondary">
                    v{version.versionNo} - {new Date(version.createdAt).toLocaleString()} -{" "}
                    <span className="text-text">{version.body.slice(0, 60)}</span>
                  </span>
                  {!isCurrent && (
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      disabled={restoring}
                      onClick={() => onRestore(version.body)}
                      data-testid={`restore-version-${version.versionNo}`}
                    >
                      Restore
                    </Button>
                  )}
                </li>
              );
            })}
          </ul>
        )}
      </div>
    </details>
  );
}

export { VersionHistory };
