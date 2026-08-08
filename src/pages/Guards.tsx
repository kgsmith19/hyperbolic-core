import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { KeyRound, Shield, ShieldOff } from "lucide-react";
import { api } from "@/api";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";

// One list column (secrets / locked paths / watched folders) with add/remove
// through the engine's paired verbs.
function ProtList({ title, items, addVerb, rmVerb, onDone }:
  { title: string; items: string[]; addVerb: string; rmVerb: string; onDone: () => void }) {
  const [val, setVal] = useState("");
  const [sel, setSel] = useState("");
  const run = useMutation({ mutationFn: (a: { verb: string; arg: string }) => api.engine(a.verb, a.arg), onSuccess: onDone });
  return (
    <div className="space-y-2">
      <h3 className="text-sm font-medium">{title}</h3>
      <select size={4} className="w-full rounded-md border bg-transparent p-1 text-sm" value={sel} onChange={(e) => setSel(e.target.value)}>
        {items.map((i) => <option key={i} value={i}>{i}</option>)}
      </select>
      <div className="flex gap-2">
        <Input className="text-xs" placeholder="pattern or path" value={val} onChange={(e) => setVal(e.target.value)} />
        <Button size="sm" variant="outline" disabled={!val.trim()} onClick={() => { run.mutate({ verb: addVerb, arg: val.trim() }); setVal(""); }}>Add</Button>
        <Button size="sm" variant="outline" disabled={!sel} onClick={() => run.mutate({ verb: rmVerb, arg: sel })}>Remove</Button>
      </div>
    </div>
  );
}

export default function Guards() {
  const qc = useQueryClient();
  const refresh = () => { qc.invalidateQueries({ queryKey: ["guards"] }); qc.invalidateQueries({ queryKey: ["runbox"] }); };
  const status = useQuery({ queryKey: ["guards"], queryFn: api.guardsStatus });
  const list = useQuery({ queryKey: ["runbox"], queryFn: api.guardsList });
  const [ref, setRef] = useState("");
  const [vault, setVault] = useState("");
  const [vaultKey, setVaultKey] = useState("");
  const [msg, setMsg] = useState("");
  const preview = useQuery({ queryKey: ["preview", ref], queryFn: () => api.preview(ref), enabled: !!ref });
  const engine = useMutation({
    mutationFn: (a: { verb: string; arg?: string; extra?: object }) => api.engine(a.verb, a.arg, a.extra),
    onSuccess: (r) => { setMsg(r.error || r.out || ""); refresh(); },
  });
  const importVault = useMutation({
    mutationFn: api.vaultImport,
    onSuccess: (r) => { setVault(""); setMsg(r.error || (r.stored ? `stored: ${r.stored.join(", ")}` : r.out || "")); refresh(); },
  });
  const rmVaultKey = useMutation({
    mutationFn: api.vaultRm,
    onSuccess: (r) => { setVaultKey(""); setMsg(r.error || r.out || ""); refresh(); },
  });
  const s = status.data;
  const enabled = !!s?.enabled;

  return (
    <div className="space-y-6">
      <Card>
        <CardHeader className="flex-row items-center gap-3">
          <CardTitle className="flex items-center gap-2">
            {enabled ? <Shield className="size-5 text-green-600" /> : <ShieldOff className="size-5 text-destructive" />}
            Guards <Badge variant={enabled ? "default" : "destructive"}>{enabled ? "ENABLED" : "DISABLED"}</Badge>
          </CardTitle>
          <Button size="sm" variant="outline" className="ml-auto" onClick={() => engine.mutate({ verb: "toggle", arg: enabled ? "off" : "on" })}>
            Turn {enabled ? "off" : "on"}
          </Button>
        </CardHeader>
        <CardContent className="grid gap-6 sm:grid-cols-3">
          <ProtList title="Secret patterns" items={s?.secrets ?? []} addVerb="secret-add" rmVerb="secret-rm" onDone={refresh} />
          <ProtList title="Locked paths" items={s?.protected ?? []} addVerb="protected-add" rmVerb="protected-rm" onDone={refresh} />
          <ProtList title="Watched folders" items={s?.projects ?? []} addVerb="projects-add" rmVerb="projects-rm" onDone={refresh} />
        </CardContent>
      </Card>

      <Card>
        <CardHeader><CardTitle className="flex items-center gap-2"><KeyRound className="size-4" /> Passwords and keys</CardTitle></CardHeader>
        <CardContent className="space-y-2">
          <p className="text-xs text-muted-foreground">One <code>NAME=value</code> per line — values go straight to the vault and are never shown again.</p>
          <Textarea rows={3} placeholder={"API_KEY=abc123\nDB_PASSWORD=hunter2"} value={vault} onChange={(e) => setVault(e.target.value)} />
          <div className="flex flex-wrap items-center gap-2">
            <Button size="sm" onClick={() => {
              const pairs = vault.split("\n").map((l) => l.trim()).filter((l) => l.indexOf("=") > 0)
                .map((l) => ({ key: l.slice(0, l.indexOf("=")).trim(), value: l.slice(l.indexOf("=") + 1) }));
              if (pairs.length) importVault.mutate(pairs);
            }}>Save to vault</Button>
            <select className="rounded-md border bg-transparent p-1.5 text-sm" value={vaultKey} onChange={(e) => setVaultKey(e.target.value)}>
              <option value="">(keys Claude can use)</option>
              {(s?.vaultKeys ?? []).map((k) => <option key={k} value={k}>{k}</option>)}
            </select>
            <Button size="sm" variant="outline" disabled={!vaultKey} onClick={() => rmVaultKey.mutate(vaultKey)}>Delete key</Button>
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader><CardTitle>Claude's requests (runbox)</CardTitle></CardHeader>
        <CardContent className="space-y-3">
          <div className="grid gap-4 sm:grid-cols-2">
            <div>
              <h3 className="mb-1 text-sm font-medium">Pending</h3>
              <select size={5} className="w-full rounded-md border bg-transparent p-1 text-sm" value={ref} onChange={(e) => setRef(e.target.value)}>
                {(list.data?.pending ?? []).map((i) => <option key={`${i.label}:${i.name}`} value={`${i.label}:${i.name}`}>{i.label}:{i.name}{i.summary ? ` — ${i.summary}` : ""}</option>)}
              </select>
            </div>
            <div>
              <h3 className="mb-1 text-sm font-medium">Trash (undo lives here)</h3>
              <select size={5} className="w-full rounded-md border bg-transparent p-1 text-sm" onChange={(e) => e.target.value && engine.mutate({ verb: "restore", arg: e.target.value })}>
                {(list.data?.trashed ?? []).map((i) => <option key={`${i.label}:${i.name}`} value={`${i.label}:${i.name}`}>{i.label}:{i.name}</option>)}
              </select>
            </div>
          </div>
          {ref && <pre className="max-h-48 overflow-auto rounded-md bg-muted p-2 text-xs whitespace-pre-wrap">{preview.data?.content ?? preview.data?.error ?? "…"}</pre>}
          <div className="flex flex-wrap gap-2">
            <Button size="sm" disabled={!ref} onClick={() => engine.mutate({ verb: "run", arg: ref })}>Run selected</Button>
            <Button size="sm" variant="outline" disabled={!ref} onClick={() => engine.mutate({ verb: "trash", arg: ref })}>Delete (to trash)</Button>
            <Button size="sm" variant="destructive" onClick={() => confirm("Permanently delete everything in the runbox trash?") && engine.mutate({ verb: "flush", extra: { confirm: true } })}>Empty trash…</Button>
          </div>
          {msg && <pre data-testid="result" className="max-h-40 overflow-auto rounded-md bg-muted p-2 text-xs whitespace-pre-wrap">{msg}</pre>}
        </CardContent>
      </Card>
    </div>
  );
}
