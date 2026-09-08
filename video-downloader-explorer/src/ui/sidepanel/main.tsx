import React from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App";
import "./styles.css";

interface ErrorInfo { error: Error; componentStack?: string | null }

class ErrorBoundary extends React.Component<{ children: any }, { info: ErrorInfo | null }> {
  constructor(props: any) { super(props); this.state = { info: null }; }
  static getDerivedStateFromError(error: Error) { return { info: { error } }; }
  componentDidCatch(error: Error, info: any) {
    console.error("[VDE UI ERROR]", error, info);
    this.setState({ info: { error, componentStack: info?.componentStack } });
  }
  render() {
    if (this.state.info) {
      const { error, componentStack } = this.state.info;
      return (
        <div className="app" style={{ padding: 20, color: "#fca5a5", background: "#0f172a", minHeight: "100vh" }}>
          <h1 style={{ fontSize: 18, margin: "0 0 12px 0" }}>⚠️ Ошибка UI</h1>
          <p style={{ margin: "0 0 12px 0", color: "#fda4af" }}>{String(error?.message || error)}</p>
          <pre style={{ fontSize: 11, overflow: "auto", background: "#1e293b", padding: 10, borderRadius: 4, whiteSpace: "pre-wrap", wordBreak: "break-word" }}>
            {String(error?.stack || "")}
          </pre>
          {componentStack && (
            <pre style={{ fontSize: 10, marginTop: 10, overflow: "auto", background: "#1e293b", padding: 10, borderRadius: 4, color: "#94a3b8", whiteSpace: "pre-wrap" }}>
              {String(componentStack)}
            </pre>
          )}
          <button className="btn primary" onClick={() => location.reload()} style={{ marginTop: 12 }}>Перезагрузить панель</button>
        </div>
      );
    }
    return this.props.children;
  }
}

const rootEl = document.getElementById("root");
if (rootEl) {
  createRoot(rootEl).render(
    <React.StrictMode>
      <ErrorBoundary>
        <App />
      </ErrorBoundary>
    </React.StrictMode>
  );
}
