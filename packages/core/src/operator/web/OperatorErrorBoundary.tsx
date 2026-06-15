import { Component, type ErrorInfo, type ReactNode } from "react";

interface OperatorErrorBoundaryProps {
  children: ReactNode;
}

interface OperatorErrorBoundaryState {
  error: Error | null;
}

export function legacyCockpitHref(search = location.search): string {
  return `/${search || ""}`;
}

export class OperatorErrorBoundary extends Component<
  OperatorErrorBoundaryProps,
  OperatorErrorBoundaryState
> {
  state: OperatorErrorBoundaryState = { error: null };

  static getDerivedStateFromError(error: Error): OperatorErrorBoundaryState {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error("operator_react_render_failed", error, info.componentStack);
  }

  render() {
    if (!this.state.error) return this.props.children;
    return (
      <main className="op-fatal" role="alert">
        <section>
          <h1>Operator UI crashed</h1>
          <p>{this.state.error.message || "A React render error interrupted the cockpit."}</p>
          <div>
            <button className="btn primary" onClick={() => location.reload()} type="button">
              Reload
            </button>
            <a className="btn" href={legacyCockpitHref()}>
              Legacy cockpit
            </a>
          </div>
        </section>
      </main>
    );
  }
}
