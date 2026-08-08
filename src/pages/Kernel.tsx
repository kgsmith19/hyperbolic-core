import { useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Cpu } from "lucide-react";
import { api, type KernelPolicy } from "@/api";
import { ApiError } from "@/components/api-error";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { LabeledInput } from "@/components/labeled-input";

export default function Kernel() {
  const qc = useQueryClient();
  const policy = useQuery({ queryKey: ["kernel"], queryFn: api.kernelPolicy });
  const [f, setF] = useState<Record<string, string>>({});
  const [msg, setMsg] = useState("");

  useEffect(() => {
    const k = policy.data?.kernel;
    if (k && Object.keys(f).length === 0) {
      setF({
        harness: k.harness, wallClockMin: String(k.budget.wallClockMin), toolCalls: String(k.budget.toolCalls),
        tokens: String(k.budget.tokens), hardWallClockMin: String(k.hardCaps.wallClockMin),
        window: String(k.autonomy.window), rejectRate: String(k.autonomy.rejectRate),
        factor: String(k.autonomy.factor), runs: String(k.autonomy.runs),
        checkpointMin: String(k.checkpointMin),
        alwaysAllowTools: k.alwaysAllowTools.join(", "), extraDenyWriteRoots: k.extraDenyWriteRoots.join(", "),
      });
    }
  }, [policy.data]);

  const save = useMutation({
    mutationFn: () => api.saveKernelPolicy({
      harness: f.harness,
      budget: { wallClockMin: Number(f.wallClockMin), toolCalls: Number(f.toolCalls), tokens: Number(f.tokens) },
      hardCaps: { wallClockMin: Number(f.hardWallClockMin) },
      autonomy: { window: Number(f.window), rejectRate: Number(f.rejectRate), factor: Number(f.factor), runs: Number(f.runs) },
      checkpointMin: Number(f.checkpointMin),
      alwaysAllowTools: f.alwaysAllowTools.split(",").map((s) => s.trim()).filter(Boolean),
      extraDenyWriteRoots: f.extraDenyWriteRoots.split(",").map((s) => s.trim()).filter(Boolean),
    } as KernelPolicy),
    onSuccess: (r) => { setMsg(r.error || "Saved — applies on the next guardhook fire."); qc.invalidateQueries({ queryKey: ["kernel"] }); },
    onError: (e) => setMsg(String(e instanceof Error ? e.message : e)),
  });

  const set = (k: string) => (v: string) => setF({ ...f, [k]: v });
  return (
    <div className="space-y-6">
      <ApiError error={policy.error} />
      <Card>
      <CardHeader><CardTitle className="flex items-center gap-2"><Cpu className="size-5" /> Kernel policy</CardTitle></CardHeader>
      <CardContent className="space-y-4">
        <LabeledInput id="harness" label="Harness" value={f.harness ?? ""} onChange={set("harness")} wide />
        <div className="flex flex-wrap gap-4">
          <LabeledInput id="wallClockMin" label="Budget wall-clock (min)" value={f.wallClockMin ?? ""} onChange={set("wallClockMin")} />
          <LabeledInput id="toolCalls" label="Tool calls" value={f.toolCalls ?? ""} onChange={set("toolCalls")} />
          <LabeledInput id="tokens" label="Tokens" value={f.tokens ?? ""} onChange={set("tokens")} />
          <LabeledInput id="hardWallClockMin" label="Hard cap wall-clock (min)" value={f.hardWallClockMin ?? ""} onChange={set("hardWallClockMin")} />
          <LabeledInput id="checkpointMin" label="Checkpoint (min)" value={f.checkpointMin ?? ""} onChange={set("checkpointMin")} />
        </div>
        <div className="flex flex-wrap gap-4">
          <LabeledInput id="window" label="Autonomy window" value={f.window ?? ""} onChange={set("window")} />
          <LabeledInput id="rejectRate" label="Reject rate" value={f.rejectRate ?? ""} onChange={set("rejectRate")} />
          <LabeledInput id="factor" label="Tighten factor" value={f.factor ?? ""} onChange={set("factor")} />
          <LabeledInput id="runs" label="Runs" value={f.runs ?? ""} onChange={set("runs")} />
        </div>
        <LabeledInput id="alwaysAllowTools" label="Always-allow tools (comma-separated)" value={f.alwaysAllowTools ?? ""} onChange={set("alwaysAllowTools")} wide />
        <LabeledInput id="extraDenyWriteRoots" label="Extra deny write roots (comma-separated)" value={f.extraDenyWriteRoots ?? ""} onChange={set("extraDenyWriteRoots")} wide />
        <div className="flex items-center gap-3">
          <Button onClick={() => save.mutate()}>Save</Button>
          <span data-testid="kernelMsg" className="text-sm text-muted-foreground">{msg}</span>
        </div>
      </CardContent>
    </Card>
    </div>
  );
}
