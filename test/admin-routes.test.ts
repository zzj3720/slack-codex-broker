import http from "node:http";
import vm from "node:vm";

import { afterEach, describe, expect, it } from "vitest";

import { loadConfig } from "../src/config.js";
import { createHttpHandler } from "../src/http/router.js";

describe("admin routes", () => {
  const cleanups: Array<() => Promise<void>> = [];

  afterEach(async () => {
    while (cleanups.length > 0) {
      await cleanups.pop()?.();
    }
  });

  it("requires the configured admin token for admin api requests", async () => {
    const config = loadConfig({
      SLACK_APP_TOKEN: "xapp-test",
      SLACK_BOT_TOKEN: "xoxb-test",
      BROKER_ADMIN_TOKEN: "secret-token"
    } as NodeJS.ProcessEnv);
    const adminService = {
      getStatus: async () => ({ ok: true, status: "admin-ok" }),
      replaceAuthFiles: async () => ({ ok: true })
    };

    const server = http.createServer(
      createHttpHandler({
        adminService: adminService as never,
        bridge: {} as never,
        jobManager: {} as never,
        config
      })
    );
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    cleanups.push(async () => {
      await new Promise<void>((resolve, reject) => {
        server.close((error) => {
          if (error) {
            reject(error);
            return;
          }
          resolve();
        });
      });
    });

    const address = server.address();
    if (!address || typeof address === "string") {
      throw new Error("failed to start test server");
    }
    const baseUrl = `http://127.0.0.1:${address.port}`;

    const unauthorized = await fetch(`${baseUrl}/admin/api/status`);
    expect(unauthorized.status).toBe(401);

    const authorized = await fetch(`${baseUrl}/admin/api/status`, {
      headers: {
        "x-admin-token": "secret-token"
      }
    });
    expect(authorized.status).toBe(200);
    await expect(authorized.json()).resolves.toMatchObject({
      ok: true,
      status: "admin-ok"
    });
  });

  it("renders integrated auth file controls and collapsed session shells in the admin page", async () => {
    const config = loadConfig({
      SLACK_APP_TOKEN: "xapp-test",
      SLACK_BOT_TOKEN: "xoxb-test"
    } as NodeJS.ProcessEnv);
    const adminService = {
      getStatus: async () => ({ ok: true, status: "admin-ok" }),
      replaceAuthFiles: async () => ({ ok: true })
    };

    const server = http.createServer(
      createHttpHandler({
        adminService: adminService as never,
        bridge: {} as never,
        jobManager: {} as never,
        config
      })
    );
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    cleanups.push(async () => {
      await new Promise<void>((resolve, reject) => {
        server.close((error) => {
          if (error) {
            reject(error);
            return;
          }
          resolve();
        });
      });
    });

    const address = server.address();
    if (!address || typeof address === "string") {
      throw new Error("failed to start test server");
    }

    const page = await fetch(`http://127.0.0.1:${address.port}/admin`);
    expect(page.status).toBe(200);
    const html = await page.text();

    expect(html).toContain("open-auth-dialog");
    expect(html).toContain("open-credentials-dialog");
    expect(html).toContain("open-config-dialog");
    expect(html).toContain("登录文件直接在条目里看状态和替换");
    expect(html).not.toContain("<h2>替换登录态</h2>");
    expect(html).toContain("session-shell");
    expect(html).toContain("session-search");
    expect(html).toContain("高密度视图");
  });

  it("emits admin page inline script without syntax errors", async () => {
    const config = loadConfig({
      SLACK_APP_TOKEN: "xapp-test",
      SLACK_BOT_TOKEN: "xoxb-test"
    } as NodeJS.ProcessEnv);
    const adminService = {
      getStatus: async () => ({ ok: true, status: "admin-ok" }),
      replaceAuthFiles: async () => ({ ok: true })
    };

    const server = http.createServer(
      createHttpHandler({
        adminService: adminService as never,
        bridge: {} as never,
        jobManager: {} as never,
        config
      })
    );
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    cleanups.push(async () => {
      await new Promise<void>((resolve, reject) => {
        server.close((error) => {
          if (error) {
            reject(error);
            return;
          }
          resolve();
        });
      });
    });

    const address = server.address();
    if (!address || typeof address === "string") {
      throw new Error("failed to start test server");
    }

    const page = await fetch(`http://127.0.0.1:${address.port}/admin`);
    const html = await page.text();
    const scriptMatch = html.match(/<script>([\s\S]*)<\/script>/);
    expect(scriptMatch?.[1]).toBeTruthy();
    const scriptSource = scriptMatch?.[1];
    if (!scriptSource) {
      throw new Error("missing admin inline script");
    }
    expect(() => new vm.Script(scriptSource)).not.toThrow();
  });
});
