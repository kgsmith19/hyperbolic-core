import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Circle, FileText, MessageSquarePlus, Play, Rocket } from "lucide-react";
import { api, type Directive } from "@/api";
import { ApiError } from "@/components/api-error";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import { errMsg } from "@/lib/utils";

function Row({ d }: { d: Directive }) {
  const qc = useQueryClient();
  const [logOpen, setLogOpen] = useState(false);
  const log = useQuery({
    queryKey: ["log", d.id],
    queryFn: () => api.directiveLog(d.id),
    enabled: logOpen,
    refetchInterval: 5000, // live tail while open
  });
  const act = useMutation({
    mutationFn: ({ status, why }: { status: "done" | "paused"; why?: string }) => api.setStatus(d.id, status, why),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["directives"] }),
  });
  const launch = useMutation({
    mutationFn: () => api.launch(d.id),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["directives"] }),
  });
  // Steer a running directive without restarting it — picked up on the next
  // resume via the log tail SessionStart already injects.
  const guide = useMutation({ mutationFn: (text: string) => api.note(d.id, text) });
  return (
    <div className="rounded-lg border p-3 text-sm">
      <div className="flex items-center gap-2">
        <Badge variant={d.running ? "default" : "secondary"}>
          <Circle className={d.running ? "size-2 fill-green-400 text-green-400" : "size-2"} />
          {d.running ? "running" : "idle"}
        </Badge>
        <span className="font-mono text-xs text-muted-foreground">{d.id}</span>
        <span className="ml-auto text-xs text-muted-foreground">{d.cycles || 0} restarts</span>
      </div>
      <p className="mt-1 truncate" title={d.text}>{d.text.split("\n")[0]}</p>
      <div className="mt-2 flex flex-wrap gap-2">
        {!d.running && (
          <Button size="sm" variant="outline" disabled={launch.isPending} onClick={() => confirm(`Relaunch ${d.id}? This starts a real agent process running again.`) && launch.mutate()}>
            <Play className="size-3.5" /> Launch
          </Button>
        )}
        <Button size="sm" variant="outline" onClick={() => act.mutate({ status: "done", why: "finished from the Command Center" })}>Mark finished</Button>
        <Button size="sm" variant="outline" onClick={() => act.mutate({ status: "paused" })}>Stop restarting</Button>
        <Button size="sm" variant="ghost" onClick={() => {
          const text = window.prompt(`Guidance for ${d.id} — picked up on the next resume, no restart needed:`);
          if (text?.trim()) guide.mutate(text.trim());
        }}><MessageSquarePlus className="size-3.5" /> Guide</Button>
        <Button size="sm" variant="ghost" onClick={() => setLogOpen(!logOpen)}><FileText className="size-3.5" /> {logOpen ? "Hide log" : "View log"}</Button>
      </div>
      {logOpen && <pre className="mt-2 max-h-60 overflow-auto rounded-md bg-muted p-2 text-xs whitespace-pre-wrap">{log.data ?? "…"}</pre>}
    </div>
  );
}

export default function StartWork() {
  const qc = useQueryClient();
  const [text, setText] = useState("");
  const [cwd, setCwd] = useState("");
  const [profile, setProfile] = useState("");
  const [note, setNote] = useState("");

  const directives = useQuery({ queryKey: ["directives"], queryFn: api.directives, refetchInterval: 5000 });
  const proc = useQuery({ queryKey: ["process"], queryFn: api.processStatus });
  const lane = useQuery({ queryKey: ["lane"], queryFn: api.lane });
  const profiles = proc.data?.profiles ?? [];
  const chosen = profile || profiles[0] || "";

  const suggest = useMutation({
    mutationFn: api.suggest,
    onSuccess: (r) => {
      if (r.path) { setCwd(r.path); setNote(`Folder set to ${r.label} — change it if wrong.`); }
      else setNote("No clear match — set the folder yourself.");
    },
  });
  const go = useMutation({
    mutationFn: async () => {
      const d = await api.createDirective({ text: text.trim(), cwd: cwd.trim(), profile: chosen });
      if (d.error || !d.id) throw new Error(d.error || "create failed");
      const l = await api.launch(d.id);
      if (l.error) throw new Error(`created ${d.id} but not launched: ${l.error}`);
      return d.id;
    },
    onSuccess: (id) => { setNote(`launched ${id}`); setText(""); qc.invalidateQueries({ queryKey: ["directives"] }); },
    onError: (e) => setNote(errMsg(e)),
  });

  const anyError = directives.error ?? proc.error ?? lane.error;

  return (
    <div className="space-y-6">
      <ApiError error={anyError} />
      <Card>
        <CardHeader><CardTitle>Start work</CardTitle></CardHeader>
        <CardContent className="space-y-3">
          <Textarea id="task" placeholder="What should Claude do?" rows={3} value={text}
            onChange={(e) => setText(e.target.value)}
            onBlur={() => text.trim() && suggest.mutate(text.slice(0, 2000))} />
          <div className="flex flex-wrap items-center gap-3">
            <Label htmlFor="cwd">Folder</Label>
            <Input id="cwd" className="w-80 font-mono text-xs" value={cwd} onChange={(e) => setCwd(e.target.value)} />
          </div>
          {profiles.length > 0 && (
            <RadioGroup className="flex gap-4" value={chosen} onValueChange={setProfile}>
              {profiles.map((p) => (
                <Label key={p} className="flex items-center gap-2 font-normal">
                  <RadioGroupItem value={p} /> {p}
                </Label>
              ))}
            </RadioGroup>
          )}
          <div className="flex items-center gap-3">
            <Button disabled={!text.trim() || !cwd.trim() || go.isPending} onClick={() => confirm(`Create and launch a new agent directive in ${cwd.trim()}? This spawns a real process to work on: "${text.trim().slice(0, 120)}"`) && go.mutate()}>
              <Rocket className="size-4" /> GO
            </Button>
            <span data-testid="note" className="text-sm text-muted-foreground">{note}</span>
          </div>
          {lane.data && (
            <p className="text-xs text-muted-foreground">
              Launch lane: {lane.data.automation?.length ? `${lane.data.automation.length} automated session(s) holding a slot` : "free"}
              {lane.data.breaker?.tripped && " — circuit breaker cooling down"}
            </p>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader><CardTitle>Work in flight</CardTitle></CardHeader>
        <CardContent className="space-y-3">
          {directives.data?.length
            ? directives.data.map((d) => <Row key={d.id} d={d} />)
            : <p className="text-sm text-muted-foreground">Nothing in flight.</p>}
        </CardContent>
      </Card>
    </div>
  );
}
