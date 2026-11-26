import { Component, type ReactNode } from "react";
import { AlertTriangle } from "lucide-react";
import { Button } from "@/components/ui/button";

export class ErrorBoundary extends Component<{ children: ReactNode }, { error: Error | null }> {
  state = { error: null as Error | null };
  static getDerivedStateFromError(error: Error) {
    return { error };
  }
  componentDidCatch(error: Error) {
    console.error("[ui]", error);
  }
  render() {
    if (!this.state.error) return this.props.children;
    return (
      <div className="flex min-h-[60vh] items-center justify-center px-4 py-10" role="alert">
        <div className="w-full max-w-md text-center">
          <span className="mx-auto mb-4 flex h-12 w-12 items-center justify-center rounded-full bg-warning-soft text-warning" aria-hidden>
            <AlertTriangle className="h-6 w-6" />
          </span>
          <h2 className="text-[19px] font-semibold tracking-tight">Something went wrong on this screen</h2>
          <p className="mt-2 text-[14px] text-muted-foreground">Your saved work is safe. Reloading usually fixes this.</p>
          {this.state.error.message && (
            <p className="mt-4 break-words rounded-lg border border-card-border bg-card px-3 py-2 text-left text-[13px] text-muted-foreground">{this.state.error.message}</p>
          )}
          <div className="mt-6 flex flex-wrap justify-center gap-2">
            <Button variant="outline" onClick={() => this.setState({ error: null })}>Try again</Button>
          <Button onClick={() => { window.location.hash = "#/"; window.location.reload(); }}>Reload app</Button>
          </div>
        </div>
      </div>
    );
  }
}
