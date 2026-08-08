import { useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { CircleDollarSign, OctagonX, Play, Users } from "lucide-react";
import { api, type Dials } from "@/api";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { LabeledInput } from "@/components/labeled-input";

const TIER = {
  red: { text: "STOPPED — you hit your weekly limit", cls: "text-destructive" },
  amber: { text: "Getting expensive", cls: "text-amber-600" },
  green: { text: "Spending is fine", cls: "text-green-600" },
};

export default function Spending() {
  const qc = useQueryClient();
  const status = useQuery({ queryKey: ["process"], queryFn: api.processStatus });
  const [form, setForm] = useState<Record<string, string>>({});
  const [msg, setMsg] = useState("");
  const s = status.data;

  // Seed the form once from the live dials; edits after that always win.
  useEffect(() => {
    if (s?.dials && Object.keys(form).length === 0) {
      setForm({
        softK: String(s.dials.softK ?? ""), hardK: String(s.dials.hardK ?? ""),
        maxFinders: String(s.dials.maxFinders ?? ""),
        amber: s.dials.amberTokens != null ? String(s.dials.amberTokens / 1e9) : "",
        red: s.dials.redTokens != null ? String(s.dials.redTokens / 1e9) : "",
        allow: (s.dials.allow ?? []).join(", "),
      });
    }
  }, [s]);

  const save = useMutation({
    mutationFn: () => api.saveDials({
      softK: Number(form.softK), hardK: Number(form.hardK), maxFinders: Number(form.maxFinders),
      amberTokens: Math.round(Number(form.amber) * 1e9), redTokens: Math.round(Number(form.red) * 1e9),
      allow: (form.allow ?? "").split(",").map((x) => x.trim()).filter(Boolean),
    } as Dials),
    onSuccess: (r) => { setMsg(r.error || "Saved — hooks pick this up on the next fire."); qc.invalidateQueries({ queryKey: ["process"] }); },
  });
  const control = useMutation({
    mutationFn: api.control,
    onSuccess: (r) => { setMsg(r.error || r.out || "done"); qc.invalidateQueries({ queryKey: ["process"] }); },
  });

  const tier = s?.tier?.tier;
  const t = tier ? TIER[tier] : null;
  const set = (k: string) => (v: string) => setForm({ ...form, [k]: v });

  return (
    <div className="space-y-6">
      <Card>
        <CardHeader><CardTitle className="flex items-center gap-2"><CircleDollarSign className="size-5" /> Spending &amp; limits</CardTitle></CardHeader>
        <CardContent className="space-y-4">
          <div>
            <p data-testid="tier" className={`text-lg font-semibold ${t?.cls ?? ""}`}>{t?.text ?? "no usage data"}</p>
            <p className="text-sm text-muted-foreground">
              {s?.tier ? `Used ${Math.round(s.tier.pct || 0)}% of your weekly limit.  ` : ""}{s?.weekText}
            </p>
          </div>
          <div className="flex flex-wrap gap-4">
            <LabeledInput id="softK" label="Warn a session at (k)" value={form.softK ?? ""} onChange={set("softK")} />
            <LabeledInput id="hardK" label="Force save at (k)" value={form.hardK ?? ""} onChange={set("hardK")} />
            <LabeledInput id="maxFinders" label="Max helpers" value={form.maxFinders ?? ""} onChange={set("maxFinders")} />
            <LabeledInput id="amber" label="Warn week (B tokens)" value={form.amber ?? ""} onChange={set("amber")} />
            <LabeledInput id="red" label="STOP week (B tokens)" value={form.red ?? ""} onChange={set("red")} />
          </div>
          <div className="space-y-1">
            <Label htmlFor="allow" className="text-xs">Helpers allowed (comma-separated)</Label>
            <Input id="allow" className="max-w-md" value={form.allow ?? ""} onChange={(e) => set("allow")(e.target.value)} />
          </div>
          <div className="flex items-center gap-3">
            <Button onClick={() => save.mutate()}>Save my limits</Button>
            <span data-testid="dialsMsg" className="text-sm text-muted-foreground">{msg}</span>
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader><CardTitle>Emergency stop</CardTitle></CardHeader>
        <CardContent className="space-y-3">
          <p data-testid="stopState" className="text-sm">{s?.stopped ? "STOPPED — no new automated work will start." : "Running normally."}</p>
          <div className="flex flex-wrap gap-2">
            <Button variant="destructive" onClick={() => control.mutate("stop")}><OctagonX className="size-4" /> STOP all automated work</Button>
            <Button variant="outline" onClick={() => control.mutate("resume")}><Play className="size-4" /> Resume work</Button>
            <Button variant="outline" onClick={() => control.mutate("fanout")}><Users className="size-4" /> Extra helpers for 30 min</Button>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
