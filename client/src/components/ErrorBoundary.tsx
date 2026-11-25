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
      <div className="mx-auto max-w-md p-8 text-center space-y-3" role="alert">
        <AlertTriangle className="mx-auto h-8 w-8 text-warning" />
        <h2 className="font-semibold">Something went wrong on this screen</h2>
        <p className="text-sm text-muted-foreground break-words">{this.state.error.message}</p>
        <p className="text-xs text-muted-foreground">Your saved work is safe. Reloading usually fixes this.</p>
        <div className="flex justify-center gap-2">
          <Button variant="outline" onClick={() => this.setState({ error: null })}>Try again</Button>
          <Button onClick={() => { window.location.hash = "#/"; window.location.reload(); }}>Reload app</Button>
        </div>
      </div>
    );
  }
}
