export function renderAdminPage(options: {
  readonly serviceName: string;
}): string {
  const configJson = JSON.stringify({ serviceName: options.serviceName }).replaceAll("<", "\\u003c");
  const adminUiDevOrigin = normalizeAdminUiDevOrigin(process.env.ADMIN_UI_DEV_ORIGIN);
  const styleLink = adminUiDevOrigin ? "" : `  <link rel="stylesheet" href="/admin/assets/admin-ui.css" />\n`;
  const scriptTags = adminUiDevOrigin
    ? `  <script type="module">
    import RefreshRuntime from "${escapeHtml(adminUiDevOrigin)}/@react-refresh";
    RefreshRuntime.injectIntoGlobalHook(window);
    window.$RefreshReg$ = () => {};
    window.$RefreshSig$ = () => (type) => type;
    window.__vite_plugin_react_preamble_installed__ = true;
  </script>
  <script type="module" src="${escapeHtml(adminUiDevOrigin)}/@vite/client"></script>
  <script type="module" src="${escapeHtml(adminUiDevOrigin)}/src/admin-ui/main.tsx"></script>`
    : `  <script type="module" src="/admin/assets/admin-ui.js"></script>`;

  return `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>${escapeHtml(options.serviceName)} 管理台</title>
${styleLink.trimEnd()}
</head>
<body>
  <div id="admin-root"></div>
  <script id="admin-config" type="application/json">${configJson}</script>
${scriptTags}
</body>
</html>`;
}

function normalizeAdminUiDevOrigin(value: string | undefined): string | null {
  if (!value) {
    return null;
  }

  try {
    const url = new URL(value);
    if (url.protocol !== "http:" && url.protocol !== "https:") {
      return null;
    }
    url.pathname = "";
    url.search = "";
    url.hash = "";
    return url.toString().replace(/\/$/, "");
  } catch {
    return null;
  }
}

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}
