import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import net from "node:net";
import { spawn } from "node:child_process";
import { Store } from "../server/store.js";
import { Auth } from "../server/auth.js";
import { Collector } from "../server/collector.js";
import { chromium } from "playwright";

test(
  "real persisted profiles export individually; only admin can download; audit contains no values",
  { timeout: 45000 },
  async () => {
    const data = mkdtempSync(path.join(tmpdir(), "ledger-cookie-api-"));
    const store = new Store(path.join(data, "live.sqlite"));
    store.setSettings({ enabled: false, realtimeEnabled: false });
    const auth = new Auth(store, data);
    const anchor = store.saveAnchor({ name: "测试主播" });
    const other = store.saveAnchor({ name: "其他主播" });
    const accounts = [anchor, other, anchor].map((a) =>
      store.createAccount({ anchorId: a.id }),
    );
    auth.save({
      username: "cookie-owner",
      password: "test123",
      anchorId: anchor.id,
      enabled: true,
    });
    store.db
      .prepare("UPDATE anchors SET is_leader=1 WHERE id=?")
      .run(anchor.id);
    const collector = new Collector(store, data);
    for (let i = 0; i < 2; i++) {
      store.updateAccount(accounts[i].id, {
        nickname: `测试账号${i + 1}`,
        status: "ready",
      });
      const context = await collector.launch(accounts[i].id);
      try {
        await context.addCookies([
          {
            name: "sessionid",
            value: `synthetic-account-${i}`,
            domain: ".douyin.com",
            path: "/",
            secure: true,
            httpOnly: true,
            sameSite: "None",
            expires: Math.floor(Date.now() / 1000) + 3600,
          },
          {
            name: "host-scope",
            value: `host-${i}`,
            domain: "anchor.douyin.com",
            path: "/anchor",
            secure: true,
            httpOnly: false,
            sameSite: "Strict",
            expires: Math.floor(Date.now() / 1000) + 3600,
          },
          {
            name: "foreign",
            value: "must-not-export",
            domain: "example.org",
            path: "/",
            expires: Math.floor(Date.now() / 1000) + 3600,
          },
        ]);
      } finally {
        await context.close();
      }
    }
    store.close();
    const socket = net.createServer();
    await new Promise((resolve) => socket.listen(0, "127.0.0.1", resolve));
    const port = socket.address().port;
    await new Promise((resolve) => socket.close(resolve));
    const base = `http://127.0.0.1:${port}`;
    let browser;
    const child = spawn(
      process.execPath,
      ["--experimental-sqlite", "server/index.js"],
      {
        cwd: path.resolve(import.meta.dirname, ".."),
        env: {
          ...process.env,
          PORT: String(port),
          LIVE_DATA_DIR: data,
          LIVE_ORIGIN: base,
        },
        stdio: "ignore",
      },
    );
    const request = (route, cookie, method = "POST", headers = {}) =>
      fetch(base + route, {
        method,
        headers: {
          "Content-Type": "application/json",
          ...(cookie ? { Cookie: cookie } : {}),
          ...headers,
        },
        ...(method === "POST" ? { body: "{}" } : {}),
      });
    try {
      let ready = false;
      for (let i = 0; i < 100; i++) {
        try {
          if ((await fetch(base + "/api/health")).ok) {
            ready = true;
            break;
          }
        } catch {}
        if (child.exitCode !== null) throw new Error("Fixture server exited");
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
      assert.ok(ready, "fixture server ready");
      const login = async (username, password) => {
        const res = await fetch(base + "/api/auth/login", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ username, password }),
        });
        assert.equal(res.status, 200);
        return res.headers
          .getSetCookie()
          .find((c) => /^ledger_session=[a-f0-9]{64};/.test(c))
          .split(";")[0];
      };
      const password = readFileSync(
        path.join(data, "initial-admin.txt"),
        "utf8",
      ).match(/Password: (.+)/)[1];
      const admin = await login("admin", password);
      const owner = await login("cookie-owner", "test123");
      const route = (i) => `/api/accounts/${accounts[i].id}/cookies/export`;
      assert.equal((await request(route(0))).status, 401);
      assert.equal((await request(route(0), owner)).status, 403);
      assert.equal((await request(route(1), owner)).status, 404);
      assert.equal(
        (
          await request(route(0), admin, "POST", {
            Origin: "https://example.org",
          })
        ).status,
        403,
      );
      for (let i = 0; i < 2; i++) {
        const res = await request(route(i), admin);
        assert.equal(res.status, 200);
        assert.match(
          res.headers.get("content-disposition"),
          /attachment;.*\.json/,
        );
        assert.equal(res.headers.get("cache-control"), "no-store");
        const cookies = await res.json();
        assert.equal(cookies.length, 2);
        assert.equal(
          cookies.find((c) => c.name === "sessionid").value,
          `synthetic-account-${i}`,
        );
        assert.equal(
          cookies.find((c) => c.name === "sessionid").sameSite,
          "no_restriction",
        );
        assert.equal(
          cookies.find((c) => c.name === "host-scope").path,
          "/anchor",
        );
        assert.equal(
          cookies.find((c) => c.name === "host-scope").hostOnly,
          true,
        );
      }
      assert.equal((await request(route(2), admin)).status, 400);
      assert.equal(
        (await request("/api/accounts/../../etc/cookies/export", admin)).status,
        404,
      );
      const audits = await (await request("/api/audits", admin, "GET")).json();
      const exports = audits.items.filter(
        (a) => a.action === "导出抖音 Cookie",
      );
      assert.equal(exports.length, 2);
      assert.ok(exports.every((a) => JSON.parse(a.details).count === 2));
      assert.ok(!JSON.stringify(audits).includes("synthetic-account"));
      const state = await (await request("/api/state", admin, "GET")).json();
      assert.ok(!JSON.stringify(state).includes("synthetic-account"));
      browser = await chromium.launch({
        headless: true,
        channel: process.platform === "win32" ? "msedge" : undefined,
      });
      const page = await browser.newPage({
        viewport: { width: 1440, height: 1050 },
      });
      await page.goto(base + "/#anchors");
      await page.getByLabel("登录账号", { exact: true }).fill("admin");
      await page.getByLabel("密码", { exact: true }).fill(password);
      await page.getByRole("button", { name: "登录", exact: true }).click();
      const button = page.getByRole("button", {
        name: "导出 Cookie 测试账号1",
        exact: true,
      });
      await button.waitFor();
      const downloading = page.waitForEvent("download");
      await button.click();
      const download = await downloading;
      assert.match(download.suggestedFilename(), /^douyin-cookies-.*\.json$/);
      assert.equal(
        JSON.parse(readFileSync(await download.path(), "utf8")).find(
          (c) => c.name === "sessionid",
        ).value,
        "synthetic-account-0",
      );
      await page
        .getByRole("status")
        .filter({ hasText: "Cookie JSON 已下载" })
        .waitFor();
      const output = path.resolve("test-output");
      mkdirSync(output, { recursive: true });
      await page.screenshot({
        path: path.join(output, "cookie-export-admin.png"),
        fullPage: true,
      });
      await page.getByRole("button", { name: "退出登录", exact: true }).click();
      await page.getByLabel("登录账号", { exact: true }).fill("cookie-owner");
      await page.getByLabel("密码", { exact: true }).fill("test123");
      await page.getByRole("button", { name: "登录", exact: true }).click();
      await page
        .getByRole("button", { name: "检测登录状态", exact: true })
        .first()
        .waitFor();
      assert.equal(
        await page.getByRole("button", { name: /^导出 Cookie/ }).count(),
        0,
      );
    } finally {
      await browser?.close();
      const exited = new Promise((resolve) => child.once("exit", resolve));
      child.kill("SIGTERM");
      await exited;
      await collector.close();
    }
  },
);
