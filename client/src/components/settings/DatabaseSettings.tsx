import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { CheckCircle2, Copy, Database, Loader2, PlugZap, RefreshCw, XCircle } from "lucide-react";
import type { DatabaseConfig, DatabaseHealth } from "@shared/schema";
import { useApp } from "@/context/AppData";
import { api, errorMessage, queryClient, session } from "@/lib/api";
import { useToast } from "@/hooks/use-toast";
import { useConfirm } from "@/components/ConfirmDialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { Checkbox } from "@/components/ui/checkbox";
import { Field, Section } from "@/components/workspace/fields";
import { cn } from "@/lib/utils";

interface DbInfo {
  status: { connected: boolean; error: string | null; label: string | null; kind: string | null };
  health: (DatabaseHealth & { ok: boolean }) | { ok: false; error: string } | null;
  current: { kind: string; url?: string; keyHint?: string; path?: string } | null;
  managedAvailable: boolean;
  managedLabel: string | null;
  persistent: boolean;
  setupSql: string;
}

type Kind = DatabaseConfig["kind"];

export function DatabaseSettings() {
  const app = useApp();
  const { toast } = useToast();
  const confirm = useConfirm();
  const q = useQuery<DbInfo>({ queryKey: ["/api/database"] });
  const [kind, setKind] = useState<Kind>("supabase");
  const [url, setUrl] = useState("");
  const [key, setKey] = useState("");
  const [copyData, setCopyData] = useState(true);
  const [test, setTest] = useState<DatabaseHealth | null>(null);
  const [busy, setBusy] = useState<"test" | "switch" | "reconnect" | null>(null);

  const cfg = (): DatabaseConfig => (kind === "supabase" ? { kind, url: url.trim().replace(/\/+$/, ""), key: key.trim() } : { kind } as DatabaseConfig);
  const valid = kind !== "supabase" || (/^https:\/\/.+/.test(url.trim()) && key.trim().length >= 20);

  const runTest = async () => {
    setBusy("test"); setTest(null);
    try { setTest(await api<DatabaseHealth>("POST", "/api/database/test", { config: cfg() })); }
    catch (e) { setTest({ ok: false, kind, label: kind, latencyMs: null, error: errorMessage(e), missingTables: [], missingColumns: [], timesheetCount: null }); }
    finally { setBusy(null); }
  };

  const runSwitch = async () => {
    const ok = await confirm({
      title: "Switch database?",
      description: copyData ? "Everything in the current database (timesheets, locations, rates and password) is copied to the new one first. Nothing is deleted from the old one." : "The app will use the new database as-is. Your current password is carried over so you stay signed in.",
      confirmLabel: "Switch",
    });
    if (!ok) return;
    setBusy("switch");
    try {
      const r = await api<{ token: string; copied: { settings: number; timesheets: number } | null }>("POST", "/api/database/switch", { config: cfg(), copyData });
      session.set(r.token);
      setKey(""); setTest(null);
      await queryClient.invalidateQueries();
      toast({ title: "Database switched", description: r.copied ? `Copied ${r.copied.timesheets} timesheets and ${r.copied.settings} settings.` : undefined });
    } catch (e) {
      toast({ title: "Couldn't switch", description: errorMessage(e), variant: "destructive" });
    } finally { setBusy(null); }
  };

  const reconnect = async () => {
    setBusy("reconnect");
    try { await api("POST", "/api/database/reconnect"); await queryClient.invalidateQueries(); }
    catch (e) { toast({ title: "Still can't connect", description: errorMessage(e), variant: "destructive" }); }
    finally { setBusy(null); }
  };

  const d = q.data;
  const h = d?.health as DatabaseHealth | undefined;
  const kinds: { id: Kind; title: string; desc: string; show: boolean }[] = [
    { id: "supabase", title: "Supabase", desc: "Your own Supabase project (URL + key)", show: true },
    { id: "sqlite", title: "Local file", desc: "SQLite file on the server — simple, no setup", show: true },
    { id: "managed", title: d?.managedLabel ?? "Built-in connection", desc: "Supabase connection supplied by the host", show: !!d?.managedAvailable },
  ];

  return (
    <div className="space-y-4">
      <Section title="Current database" actions={<Button variant="outline" size="sm" onClick={reconnect} disabled={!!busy} data-testid="button-db-reconnect">{busy === "reconnect" ? <Loader2 className="animate-spin" /> : <RefreshCw />} Reconnect</Button>}>
        {q.isLoading ? <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" /> : !d ? <p className="text-sm text-destructive">{errorMessage(q.error)}</p> : (
          <div className="space-y-3 text-sm">
            <div className="flex flex-wrap items-center gap-2">
              <Database className="h-4 w-4 text-muted-foreground" />
              <span className="font-medium" data-testid="text-db-label">{d.status.label ?? d.current?.kind ?? "Not configured"}</span>
              {d.health?.ok ? <Badge variant="success"><CheckCircle2 />Connected</Badge> : <Badge variant="destructive"><XCircle />Problem</Badge>}
              {h?.latencyMs != null && <span className="text-xs text-muted-foreground">{h.latencyMs} ms</span>}
              {h?.timesheetCount != null && <span className="text-xs text-muted-foreground">· {h.timesheetCount} timesheets</span>}
            </div>
            {d.current?.url && <p className="text-xs text-muted-foreground break-all">{d.current.url} · key {d.current.keyHint}</p>}
            {(d.health?.error || d.status.error) && <p className="text-xs text-destructive">{d.health?.error || d.status.error}</p>}
            {h?.missingColumns?.length ? (
              <p className="text-xs text-warning">Optional columns missing: {h.missingColumns.join(", ")}. The app still works; run the setup SQL below to enable faster location filtering.</p>
            ) : null}
            {!d.persistent && <p className="text-xs text-muted-foreground">Note: this server's config folder is temporary, so a database choice made here may reset when the server restarts. Set it with environment variables for a permanent setup.</p>}
          </div>
        )}
      </Section>

      <Section title="Connect a different database" description="Test first, then switch. You can move back at any time.">
        <div className="space-y-4">
          <div className="grid gap-2 sm:grid-cols-3">
            {kinds.filter((k) => k.show).map((k) => (
              <button key={k.id} onClick={() => { setKind(k.id); setTest(null); }} className={cn("rounded-xl border border-border/80 p-3.5 text-left transition-[border-color,box-shadow] duration-150 hover:border-primary/40 focus-visible:outline-none focus-visible:ring-[3px] focus-visible:ring-ring/35", kind === k.id && "border-primary ring-[3px] ring-primary/15")} aria-pressed={kind === k.id} data-testid={`button-db-kind-${k.id}`}>
                <p className="text-sm font-medium">{k.title}</p><p className="text-xs text-muted-foreground">{k.desc}</p>
              </button>
            ))}
          </div>
          {kind === "supabase" && (
            <div className="grid gap-3 sm:grid-cols-2">
              <Field label="Project URL" hint="Supabase → Project Settings → API"><Input value={url} onChange={(e) => setUrl(e.target.value)} placeholder="https://xxxx.supabase.co" data-testid="input-db-url" /></Field>
              <Field label="Key" hint="service_role key recommended (keeps working with row level security on)"><Input type="password" autoComplete="off" value={key} onChange={(e) => setKey(e.target.value)} placeholder="eyJ… or sb_secret_…" data-testid="input-db-key" /></Field>
            </div>
          )}
          {test && (
            <div className={cn("rounded-lg border p-3 text-sm", test.ok ? "border-transparent bg-success-soft" : "border-transparent bg-danger-soft")} data-testid="text-db-test">
              {test.ok ? (
                <p className="flex items-center gap-2"><CheckCircle2 className="h-4 w-4 text-success" />Connected in {test.latencyMs} ms{test.timesheetCount != null ? ` · ${test.timesheetCount} timesheets already there` : ""}</p>
              ) : <p className="flex items-start gap-2"><XCircle className="mt-0.5 h-4 w-4 shrink-0 text-destructive" />{test.error}</p>}
              {test.missingTables.length > 0 && <p className="mt-1 text-xs">Missing tables: {test.missingTables.join(", ")} — run the setup SQL below in the Supabase SQL editor, then test again.</p>}
              {test.missingColumns.length > 0 && <p className="mt-1 text-xs">Optional columns missing: {test.missingColumns.join(", ")}.</p>}
            </div>
          )}
          {kind === "supabase" && !valid && (url.trim() || key.trim()) && (
            <p className="text-xs text-muted-foreground">{!/^https:\/\/.+/.test(url.trim()) ? "The project URL should start with https://" : "That key looks too short — paste the full key from Supabase."}</p>
          )}
          <label className="flex items-center gap-2 text-sm"><Checkbox checked={copyData} onCheckedChange={(v) => setCopyData(!!v)} data-testid="checkbox-db-copy" />Copy my current data into the new database</label>
          <div className="flex flex-wrap gap-2">
            <Button variant="outline" onClick={runTest} disabled={!valid || !!busy} data-testid="button-db-test">{busy === "test" ? <Loader2 className="animate-spin" /> : <PlugZap />} Test connection</Button>
            <Button onClick={runSwitch} disabled={!valid || !!busy || !test?.ok} data-testid="button-db-switch">{busy === "switch" && <Loader2 className="animate-spin" />}Switch to this database</Button>
          </div>
        </div>
      </Section>

      {d && (
        <Section title="Supabase setup SQL" description="Run once in a new project (SQL editor). Safe to run again — it only adds what's missing." actions={
          <Button variant="outline" size="sm" onClick={() => navigator.clipboard?.writeText(d.setupSql).then(() => toast({ title: "SQL copied" }), () => toast({ title: "Select the text and copy it manually" }))} data-testid="button-copy-sql"><Copy /> Copy</Button>
        }>
          <pre className="max-h-72 overflow-auto rounded-lg bg-foreground/[0.04] p-3 font-mono text-xs leading-relaxed"><code>{d.setupSql}</code></pre>
        </Section>
      )}
      <p className="text-xs text-muted-foreground">Active location: {app.site.name}</p>
    </div>
  );
}
