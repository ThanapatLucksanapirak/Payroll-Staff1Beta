import { useEffect, useState, useSyncExternalStore } from "react";
import { Router, Switch, Route } from "wouter";
import { useHashLocation } from "wouter/use-hash-location";
import { QueryClientProvider } from "@tanstack/react-query";
import { Loader2, RefreshCw, ServerCrash } from "lucide-react";
import { api, queryClient, session, signOut } from "@/lib/api";
import type { SessionUser } from "@/lib/roles";
import { Toaster } from "@/components/ui/toaster";
import { TooltipProvider } from "@/components/ui/tooltip";
import { ConfirmProvider } from "@/components/ConfirmDialog";
import { ErrorBoundary } from "@/components/ErrorBoundary";
import { AppDataProvider, applyTheme } from "@/context/AppData";
import { AppShell } from "@/components/AppShell";
import { LoginPage } from "@/pages/Login";
import { Dashboard } from "@/pages/Dashboard";
import { WorkspacePage } from "@/pages/Workspace";
import { SettingsPage } from "@/pages/Settings";
import { LivePage } from "@/pages/Live";
import { EmployeesPage } from "@/pages/Employees";
import { Button } from "@/components/ui/button";

interface AuthStatus { setupRequired: boolean; authenticated: boolean; appName: string; db: { connected: boolean; error: string | null }; user: SessionUser | null }

function FullScreen({ children }: { children: React.ReactNode }) {
  return <div className="min-h-dvh flex items-center justify-center p-6 text-center">{children}</div>;
}

function Gate() {
  const epoch = useSyncExternalStore(session.subscribe, session.get);
  const [status, setStatus] = useState<AuthStatus | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = () => {
    setError(null);
    api<AuthStatus>("GET", "/api/auth/status").then((st) => { session.dropLegacyToken(); setStatus(st); }).catch((e) => setError(e.message));
  };
  useEffect(load, [epoch]);
  useEffect(() => { applyTheme("system"); }, []);

  if (error) {
    return (
      <FullScreen>
        <div className="space-y-3">
          <ServerCrash className="mx-auto h-8 w-8 text-muted-foreground" />
          <p className="text-sm text-muted-foreground">{error}</p>
          <Button variant="outline" onClick={load}><RefreshCw /> Try again</Button>
        </div>
      </FullScreen>
    );
  }
  if (!status) return <FullScreen><Loader2 className="h-6 w-6 animate-spin text-muted-foreground" /></FullScreen>;
  if (!status.authenticated) {
    return <LoginPage appName={status.appName} setupRequired={status.setupRequired} dbError={status.db.connected ? null : status.db.error} onDone={() => { queryClient.clear(); load(); }} />;
  }

  return (
    <AppDataProvider
      fallback={({ error: e, retry }) => (
        <FullScreen>
          {e ? (
            <div className="space-y-3 max-w-md">
              <ServerCrash className="mx-auto h-8 w-8 text-muted-foreground" />
              <p className="text-sm">{e.message}</p>
              <div className="flex justify-center gap-2">
                <Button variant="outline" onClick={retry}><RefreshCw /> Retry</Button>
                <Button variant="ghost" onClick={() => void signOut()}>Sign out</Button>
              </div>
            </div>
          ) : <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />}
        </FullScreen>
      )}
    >
      <AppShell>
        <ErrorBoundary>
          <Switch>
            <Route path="/" component={Dashboard} />
            <Route path="/timesheet/:id">{(p) => <WorkspacePage key={p.id} id={p.id} />}</Route>
            <Route path="/live" component={LivePage} />
            <Route path="/employees" component={EmployeesPage} />
            <Route path="/settings/:section?">{(p) => <SettingsPage section={p.section} />}</Route>
            <Route><Dashboard /></Route>
          </Switch>
        </ErrorBoundary>
      </AppShell>
    </AppDataProvider>
  );
}

export default function App() {
  return (
    <QueryClientProvider client={queryClient}>
      <TooltipProvider delayDuration={300}>
        <ConfirmProvider>
          <Router hook={useHashLocation}>
            <ErrorBoundary>
              <Gate />
            </ErrorBoundary>
          </Router>
          <Toaster />
        </ConfirmProvider>
      </TooltipProvider>
    </QueryClientProvider>
  );
}
