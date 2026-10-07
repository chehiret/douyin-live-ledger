import test from "node:test";
import assert from "node:assert/strict";
import { chromium } from "playwright";
import { Store } from "../server/store.js";
import { Jobs } from "../server/jobs.js";
import { Collector, REVIEW } from "../server/collector.js";

test("two login jobs overlap, third waits, same-account checks wait, and cancellation frees one slot", async () => {
  const s = new Store(":memory:"),
    anchor = s.saveAnchor({ name: "并发测试" });
  const accounts = [0, 1, 2].map(() =>
    s.createAccount({ anchorId: anchor.id }),
  );
  const c = {
    bindings: new Map(),
    maxBrowsers: 2,
    busy: false,
    checking: null,
    startBinding: async (id) => {
      c.bindings.set(id, {});
    },
    cancelBinding: async (id) => {
      c.bindings.delete(id);
    },
    close: async () => {
      c.bindings.clear();
    },
  };
  const j = new Jobs(s, c);
  clearInterval(j.timer);
  try {
    const jobs = accounts.map((a) => j.enqueue("login", a, null));
    // Make order deterministic independently of UUIDs and clock resolution.
    jobs.forEach((job, i) =>
      s.db
        .prepare("UPDATE jobs SET created_at=? WHERE id=?")
        .run(`2026-09-08T00:00:0${i}Z`, job.id),
    );
    const first = j.tick(),
      second = j.tick();
    assert.equal(c.bindings.size, 2);
    assert.equal(j.activeTasks.size, 2);
    await j.tick();
    assert.equal(c.bindings.size, 2);
    assert.equal(
      s.db.prepare("SELECT status FROM jobs WHERE id=?").get(jobs[2].id).status,
      "queued",
    );
    await j.cancel(jobs[0].id, { role: "admin" });
    await first;
    const third = j.tick();
    assert.equal(c.bindings.size, 2);
    assert.ok(c.bindings.has(accounts[2].id));
    assert.ok(c.bindings.has(accounts[1].id));
    await j.close();
    await Promise.all([second, third]);
  } finally {
    await j.close();
    s.close();
  }
});

test("same profile is skipped without blocking another account and login can share capacity with a running sync", async () => {
  const s = new Store(":memory:"),
    anchor = s.saveAnchor({ name: "并发测试" });
  const a = s.createAccount({ anchorId: anchor.id }),
    b = s.createAccount({ anchorId: anchor.id });
  const c = {
    bindings: new Map(),
    busy: true,
    syncAccountId: a.id,
    maxBrowsers: 2,
    checking: null,
    close: async () => {},
  };
  const j = new Jobs(s, c);
  clearInterval(j.timer);
  try {
    const own = j.enqueue("login", a, null),
      other = j.enqueue("login", b, null);
    s.db
      .prepare("UPDATE jobs SET created_at='2020-01-01' WHERE id=?")
      .run(own.id);
    let picked;
    j.execute = async (job) => {
      picked = job;
    };
    await j.tick();
    assert.equal(picked.id, other.id);
  } finally {
    await j.close();
    s.close();
  }
});

test("official verification dialog is cropped and clicks/code input stay in the selected account", async () => {
  const browser = await chromium.launch({
    headless: true,
    channel: process.platform === "win32" ? "msedge" : undefined,
  });
  const s = new Store(":memory:"),
    c = new Collector(s, "unused");
  try {
    const contexts = await Promise.all([
      browser.newContext({ viewport: { width: 1440, height: 1000 } }),
      browser.newContext({ viewport: { width: 1440, height: 1000 } }),
    ]);
    const pages = [];
    for (const [i, context] of contexts.entries()) {
      await context.route("https://anchor.douyin.com/login", (route) =>
        route.fulfill({
          contentType: "text/html; charset=utf-8",
          body: `<div style="position:absolute;left:400px;top:250px;width:580px;height:420px;background:#eee"><h2>身份验证</h2><button id="sms" onclick="this.textContent='验证码已发送'">接收短信验证码</button><input id="code" /><button onclick="document.body.dataset.done=document.querySelector('#code').value">确认</button></div>`,
        }),
      );
      const page = await context.newPage();
      await page.goto("https://anchor.douyin.com/login");
      pages.push(page);
      c.bindings.set(String(i), {
        accountId: String(i),
        page,
        context,
        created: Date.now(),
      });
    }
    const frame = await c.verificationFrame("0");
    assert.equal(frame.width, 580);
    assert.equal(frame.height, 420);
    const box = await pages[0].locator("#sms").boundingBox();
    const point = { x: box.x - 400 + 10, y: box.y - 250 + 10 };
    await c.verificationInput("0", {
      type: "pointer",
      frameId: frame.frameId,
      from: point,
      to: point,
    });
    assert.equal(await pages[0].locator("#sms").innerText(), "验证码已发送");
    assert.equal(await pages[1].locator("#sms").innerText(), "接收短信验证码");
    await pages[0].locator("#code").focus();
    await c.verificationInput("0", { type: "text", text: "123456" });
    assert.equal(await pages[0].locator("#code").inputValue(), "123456");
    assert.equal(await pages[1].locator("#code").inputValue(), "");
    await assert.rejects(
      () =>
        c.verificationInput("1", {
          type: "pointer",
          frameId: frame.frameId,
          from: point,
          to: point,
        }),
      /画面已更新/,
    );
    await assert.rejects(
      () =>
        c.verificationInput("0", {
          type: "pointer",
          frameId: frame.frameId,
          from: { x: 580, y: 0 },
          to: point,
        }),
      /画面已更新/,
    );
    c.bindings.get("0").frames.get(frame.frameId).created = Date.now() - 31000;
    await assert.rejects(
      () =>
        c.verificationInput("0", {
          type: "pointer",
          frameId: frame.frameId,
          from: point,
          to: point,
        }),
      /画面已更新/,
    );
  } finally {
    await c.close();
    s.close();
    await browser.close();
  }
});

test("SMS buttons select the official method, respect cooldown, and fill plus submit only the selected account", async () => {
  const browser = await chromium.launch({
    headless: true,
    channel: process.platform === "win32" ? "msedge" : undefined,
  });
  const s = new Store(":memory:"),
    c = new Collector(s, "unused");
  try {
    const pages = [];
    for (let i = 0; i < 2; i++) {
      const context = await browser.newContext({
        viewport: { width: 1440, height: 1000 },
      });
      await context.route("https://anchor.douyin.com/login", (route) =>
        route.fulfill({
          contentType: "text/html; charset=utf-8",
          body: `<div style="position:absolute;left:400px;top:250px;width:580px;height:420px"><h2>身份验证</h2><button id="choose">接收短信验证码</button></div><script>document.querySelector("#choose").onclick=()=>{document.querySelector("div").innerHTML='<h2>接收短信验证码</h2><p>短信已发送至 193******51</p><input placeholder="请输入验证码" /><span id="resend">54s后重新发送</span><button id="verify">验证</button><p id="error"></p>';document.querySelector("#verify").onclick=()=>{document.body.dataset.submitted=document.querySelector("input").value;document.querySelector("#error").textContent="验证码错误，请重试";};};</script>`,
        }),
      );
      const page = await context.newPage();
      await page.goto("https://anchor.douyin.com/login");
      pages.push(page);
      c.bindings.set(String(i), {
        accountId: String(i),
        page,
        context,
        created: Date.now(),
      });
    }
    assert.equal((await c.verificationFrame("0")).sms.stage, "choose");
    await c.verificationInput("0", { type: "sms-request" });
    const sms = (await c.verificationFrame("0")).sms;
    assert.equal(sms.stage, "code");
    assert.equal(sms.phone, "193******51");
    assert.ok(sms.seconds >= 54);
    assert.equal(sms.canRequest, false);
    assert.equal((await c.verificationFrame("1")).sms.stage, "choose");
    await assert.rejects(
      () => c.verificationInput("0", { type: "sms-request" }),
      /倒计时/,
    );
    await assert.rejects(
      () => c.verificationInput("0", { type: "sms-submit", code: "123" }),
      /6位/,
    );
    await c.verificationInput("0", { type: "sms-submit", code: "123456" });
    assert.equal(
      await pages[0].evaluate(() => document.body.dataset.submitted),
      "123456",
    );
    assert.equal(
      await pages[1].evaluate(() => document.body.dataset.submitted),
      undefined,
    );
    assert.match((await c.verificationFrame("0")).sms.message, /验证码错误/);
    await pages[0]
      .locator("#resend")
      .evaluate((el) => (el.textContent = "重新发送"));
    c.bindings.get("0").smsRequestedAt = Date.now() - 61000;
    assert.equal((await c.verificationFrame("0")).sms.canRequest, true);
    await pages[0]
      .locator("#resend")
      .evaluate(
        (el) => (el.onclick = () => (document.body.dataset.resent = "yes")),
      );
    await c.verificationInput("0", { type: "sms-request" });
    assert.equal(
      await pages[0].evaluate(() => document.body.dataset.resent),
      "yes",
    );
    await pages[0].setContent(
      '<input placeholder="请输入验证码"/><button>验证</button>',
    );
    assert.equal((await c.verificationFrame("0")).sms, null);
    await assert.rejects(
      () => c.verificationInput("0", { type: "sms-submit", code: "123456" }),
      /不是短信/,
    );
  } finally {
    await c.close();
    s.close();
    await browser.close();
  }
});
