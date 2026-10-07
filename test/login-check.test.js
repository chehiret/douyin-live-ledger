import test from "node:test";
import assert from "node:assert/strict";
import { chromium } from "playwright";
import { Store } from "../server/store.js";
import { Collector } from "../server/collector.js";

test(
  "login checks distinguish authentication, challenges and transport failures; serialize profile use",
  { timeout: 60000 },
  async () => {
    const browser = await chromium.launch({
      headless: true,
      channel: process.platform === "win32" ? "msedge" : undefined,
    });
    const store = new Store(":memory:");
    const anchor = store.saveAnchor({ name: "测试主播" });
    const account = store.createAccount({
      anchorId: anchor.id,
      handle: "login-test",
    });
    const collector = new Collector(store, "unused");
    const inspect = collector.inspectLogin.bind(collector);
    collector.inspectLogin = (page, a) => inspect(page, a, 1000);
    let mode = "valid";
    const contexts = [];
    collector.launch = async () => {
      const context = await browser.newContext();
      contexts.push(context);
      const page = await context.newPage();
      collector.identities.set(page, "1234567890123456789");
      const goto = page.goto.bind(page);
      page.goto = (url, options) =>
        goto(
          mode === "expired" ? "https://anchor.douyin.com/login" : url,
          options,
        );
      await context.route("https://anchor.douyin.com/**", async (route) => {
        if (mode === "network") return route.abort("internetdisconnected");
        if (mode === "http")
          return route.fulfill({ status: 503, body: "Service unavailable" });
        const body = {
          valid:
            '<div class="info-test"><span class="name-test">测试昵称</span></div>',
          mismatch:
            '<div class="info-test"><span class="name-test">其他昵称</span></div>',
          expired: "<p>扫码登录</p>",
          verification: '<iframe srcdoc="<p>请输入收到的验证码</p>"></iframe>',
          blank: "<p>Loading</p>",
        }[mode];
        return route.fulfill({ contentType: "text/html; charset=utf-8", body });
      });
      return context;
    };
    try {
      for (const [scenario, expected] of [
        ["valid", "valid"],
        ["expired", "expired"],
        ["verification", "verification"],
        ["mismatch", "mismatch"],
        ["network", "unknown"],
        ["http", "unknown"],
        ["blank", "unknown"],
      ]) {
        mode = scenario;
        store.updateAccount(account.id, {
          status: "ready",
          douyin_uid: "",
          nickname: "测试昵称",
          error: "",
          last_sync: "2026-09-01T00:00:00Z",
        });
        const pending = collector.startLoginCheck(account.id);
        assert.equal(collector.checking, account.id);
        assert.throws(() => collector.startLoginCheck(account.id), /已有/);
        assert.throws(() => collector.startSync(), /已有/);
        await assert.rejects(
          () => collector.startBinding(account.id),
          /该账号正在同步或检测/,
        );
        const result = await pending;
        assert.equal(result.result, expected, scenario);
        assert.ok(result.checked_at);
        assert.equal(collector.checking, null);
        assert.equal(contexts.at(-1).pages().length, 0);
        assert.equal(
          store.account(account.id).status,
          expected === "unknown" || expected === "valid" ? "ready" : expected,
        );
        assert.equal(
          store.account(account.id).last_sync,
          "2026-09-01T00:00:00Z",
        );
        assert.equal(store.listAccounts()[0].login_checks[0].id, result.id);
      }
      mode = "valid";
      store.updateAccount(account.id, { status: "error", error: "原同步错误" });
      await collector.startLoginCheck(account.id);
      assert.equal(store.account(account.id).error, "原同步错误");
      assert.equal(store.account(account.id).status, "error");
      assert.equal(store.runs().length, 0);
      assert.equal(store.report("2026-09").sessions.length, 0);
      for (let i = 0; i < 12; i++)
        store.saveLoginCheck(account.id, "valid", "test");
      assert.equal(store.loginChecks(account.id).length, 10);
      assert.ok(
        store.loginChecks(account.id)[0].id >
          store.loginChecks(account.id)[9].id,
      );
    } finally {
      await collector.close();
      store.close();
      await browser.close();
    }
  },
);
