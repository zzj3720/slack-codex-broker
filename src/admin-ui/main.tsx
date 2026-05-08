import React from "react";
import { flushSync } from "react-dom";
import { createRoot } from "react-dom/client";

import "./admin.css";
import { publishAdminStatus } from "./admin-status-store";
import { initAdminPage } from "./admin-legacy.js";
import { renderAdminShellHtml } from "./admin-shell";
import { AdminSessionsView } from "./session-view";

interface AdminConfig {
  readonly serviceName?: string;
}

function readAdminConfig(): AdminConfig {
  const element = document.getElementById("admin-config");
  if (!element?.textContent) {
    return {};
  }

  try {
    return JSON.parse(element.textContent) as AdminConfig;
  } catch {
    return {};
  }
}

function AdminApp({ serviceName }: { readonly serviceName: string }): React.JSX.Element {
  return <div className="admin-shell-host" dangerouslySetInnerHTML={{ __html: renderAdminShellHtml(serviceName) }} />;
}

const config = readAdminConfig();
const rootElement = document.getElementById("admin-root");

if (!rootElement) {
  throw new Error("missing admin root");
}

flushSync(() => {
  createRoot(rootElement).render(<AdminApp serviceName={config.serviceName || "slack-codex-broker"} />);
});

const sessionRootElement = document.getElementById("session-react-root");
if (!sessionRootElement) {
  throw new Error("missing session root");
}

flushSync(() => {
  createRoot(sessionRootElement).render(<AdminSessionsView />);
});

initAdminPage({ useReactSessions: true, onStatus: publishAdminStatus });
