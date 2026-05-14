import { spawn } from "node:child_process";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite-plus";

const adminApiProxyOrigin = process.env.ADMIN_API_PROXY_ORIGIN;
const adminApiProxyCookie = process.env.ADMIN_API_PROXY_COOKIE;

export default defineConfig({
  root: "src/admin-ui",
  base: "/admin/",
  plugins: [
    {
      name: "admin-base-redirect",
      configureServer(server) {
        server.middlewares.use((request, response, next) => {
          if (request.url === "/admin") {
            response.statusCode = 302;
            response.setHeader("location", "/admin/");
            response.end();
            return;
          }
          next();
        });
        if (adminApiProxyOrigin) {
          server.middlewares.use("/admin/api/events", (request, response) => {
            response.writeHead(200, {
              "content-type": "text/event-stream; charset=utf-8",
              "cache-control": "no-store",
              connection: "keep-alive"
            });
            response.write(": local preview realtime disabled\n\n");
            const timer = setInterval(() => response.write(": keepalive\n\n"), 15_000);
            request.on("close", () => clearInterval(timer));
          });
          server.middlewares.use("/admin/api", (request, response) => {
            const requestUrl = request.url || "/";
            const target = new URL(`/admin/api${requestUrl}`, adminApiProxyOrigin);
            const chunks: Buffer[] = [];
            request.on("data", (chunk: Buffer) => chunks.push(chunk));
            request.on("end", () => {
              const body = Buffer.concat(chunks);
              const args = [
                "--silent",
                "--show-error",
                "--max-time",
                "60",
                "--request",
                request.method || "GET",
                "--dump-header",
                "-",
                "--output",
                "-",
                "--header",
                `accept: ${request.headers.accept || "application/json"}`
              ];
              if (adminApiProxyCookie) {
                args.push("--header", `cookie: ${adminApiProxyCookie}`);
              }
              if (request.headers["content-type"]) {
                args.push("--header", `content-type: ${request.headers["content-type"]}`);
              }
              if (body.length > 0) {
                args.push("--data-binary", "@-");
              }
              args.push(target.toString());

              const child = spawn("curl", args, {
                stdio: ["pipe", "pipe", "pipe"]
              });
              const stdout: Buffer[] = [];
              const stderr: Buffer[] = [];
              child.stdout.on("data", (chunk: Buffer) => stdout.push(chunk));
              child.stderr.on("data", (chunk: Buffer) => stderr.push(chunk));
              child.on("error", (error) => {
                response.writeHead(502, { "content-type": "application/json" });
                response.end(JSON.stringify({ ok: false, error: error.message }));
              });
              child.on("close", (code) => {
                const output = Buffer.concat(stdout);
                const headerEnd = output.indexOf(Buffer.from("\r\n\r\n"));
                if (code !== 0 || headerEnd < 0) {
                  response.writeHead(502, { "content-type": "application/json" });
                  response.end(JSON.stringify({
                    ok: false,
                    error: Buffer.concat(stderr).toString("utf8") || `curl exited with status ${code}`
                  }));
                  return;
                }
                const rawHeaders = output.subarray(0, headerEnd).toString("utf8").split("\r\n");
                const status = Number(rawHeaders[0]?.match(/\s(\d{3})\s/)?.[1] || 502);
                const headers: Record<string, string> = {
                  "cache-control": "no-store"
                };
                for (const line of rawHeaders.slice(1)) {
                  const index = line.indexOf(":");
                  if (index <= 0) continue;
                  const key = line.slice(0, index).trim().toLowerCase();
                  if (["content-length", "transfer-encoding", "connection", "set-cookie"].includes(key)) continue;
                  headers[key] = line.slice(index + 1).trim();
                }
                response.writeHead(status, headers);
                response.end(output.subarray(headerEnd + 4));
              });
              if (body.length > 0) {
                child.stdin.end(body);
              } else {
                child.stdin.end();
              }
            });
            request.resume();
          });
        }
      }
    },
    react()
  ],
  server: {
    host: "127.0.0.1",
    port: Number(process.env.ADMIN_UI_DEV_PORT || 5173),
    strictPort: true,
    cors: true
  },
  build: {
    outDir: "../../dist/admin-ui",
    emptyOutDir: true,
    rollupOptions: {
      input: "index.html",
      output: {
        entryFileNames: "assets/admin-ui.js",
        chunkFileNames: "assets/[name].js",
        assetFileNames: (assetInfo) => {
          const names = "names" in assetInfo && Array.isArray(assetInfo.names) ? assetInfo.names : [];
          const name = assetInfo.name ?? names[0] ?? "";
          return name.endsWith(".css") ? "assets/admin-ui.css" : "assets/[name][extname]";
        }
      }
    }
  }
});
