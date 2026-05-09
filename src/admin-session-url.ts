export function buildAdminSessionUrl(adminBaseUrl: string, sessionKey: string): string {
  const base = normalizeAdminBaseUrl(adminBaseUrl);
  const path = `/admin/sessions/${encodeURIComponent(sessionKey)}`;
  return `${base}${path}`;
}

function normalizeAdminBaseUrl(value: string): string {
  const trimmed = value.trim();
  if (!trimmed) {
    return "http://127.0.0.1:3000";
  }

  try {
    const url = new URL(trimmed);
    url.pathname = url.pathname.replace(/\/+$/, "");
    url.search = "";
    url.hash = "";
    return url.toString().replace(/\/$/, "");
  } catch {
    return trimmed.replace(/\/+$/, "");
  }
}
