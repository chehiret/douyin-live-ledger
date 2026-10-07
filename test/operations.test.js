import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { DatabaseSync } from "node:sqlite";
import { Store } from "../server/store.js";
import { Auth } from "../server/auth.js";
import { Jobs } from "../server/jobs.js";
import { Backups } from "../server/backups.js";
import { Collector } from "../server/collector.js";
import { chromium } from "playwright";
import { chinaDate, shiftDate, realtimeDue } from "../server/domain.js";

function fixture() {
  const dir = mkdtempSync(path.join(tmpdir(), "ledger-ops-")),
    store = new Store(path.join(dir, "live.sqlite"));
  const auth = new Auth(store, dir);
  const a = store.saveAnchor({ name: "one" }),
    b = store.saveAnchor({ name: "two" });
  const ac = store.createAccount({
    anchorId: a.id,
    handle: "one",
    trackingFrom: "2026-09-01",
  });
  const bc = store.createAccount({
    anchorId: b.id,
    handle: "two",
    trackingFrom: "2026-09-01",
  });
  store.updateAccount(ac.id, { status: "ready" });
  store.updateAccount(bc.id, { status: "ready" });
  const user = auth.save({
    username: "one",
    password: "abc123",
    anchorId: a.id,
    enabled: true,
  });
  return { dir, store, auth, a, b, ac, bc, user };
}
test("missing days are grouped and pending/rejected/future-start accounts do not reduce completeness", (t) => {
  t.mock.timers.enable({ apis: ["Date"], now: Date.parse("2026-09-06T00:00:00Z") });
  const { store, a, ac } = fixture();
  try {
    store.saveDay(ac.id, "2026-09-05", []);
    assert.deepEqual(store.automaticRanges(ac.id, "2026-09-06"), [
      { from: "2026-09-01", to: "2026-09-04" },
      { from: "2026-09-06", to: "2026-09-06" },
    ]);
    store.saveDay(ac.id, "2026-09-02", []);
    assert.deepEqual(store.automaticRanges(ac.id, "2026-09-06"), [
      { from: "2026-09-01", to: "2026-09-01" },
      { from: "2026-09-03", to: "2026-09-04" },
      { from: "2026-09-06", to: "2026-09-06" },
    ]);
    const pending = store.createAccount({ anchorId: a.id, handle: "pending" });
    store.updateAccount(pending.id, { approval: "pending" });
    const report = () =>
      store.report("2026-09", a.id, "", "2026-09-06").daily[4];
    assert.equal(report().state, "complete");
    store.updateAccount(pending.id, { approval: "rejected" });
    assert.equal(report().state, "complete");
    store.updateAccount(pending.id, {
      approval: "approved",
      tracking_from: "2026-09-06",
    });
    assert.equal(report().state, "complete");
    store.updateAccount(pending.id, { tracking_from: "2026-09-01" });
    assert.equal(report().state, "partial");
    store.updateAccount(pending.id, { enabled: 0 });
    assert.equal(report().state, "complete");
    assert.equal(
      store.report("2026-08", a.id, "", "2026-09-06").elapsedDays,
      0,
    );
  } finally {
    store.close();
  }
});
test("run pagination scopes before limiting; notices and audit details are durable", () => {
  const { store, a, ac, bc, user } = fixture();
  try {
    for (let i = 0; i < 125; i++) {
      const id = store.startRun(bc.id, "2026-09-01", "2026-09-01", "manual");
      store.endRun(id, "success", "ok");
    }
    for (let i = 0; i < 35; i++) {
      const id = store.startRun(ac.id, "2026-09-01", "2026-09-01", "manual");
      store.endRun(id, "success", "ok");
    }
    assert.equal(store.runCount(a.id), 35);
    assert.equal(store.runs(a.id, 1, 30).length, 30);
    assert.equal(store.runs(a.id, 2, 30).length, 5);
    assert.ok(store.runs(a.id).every((r) => r.account_id === ac.id));
    store.notify(ac.id, "login", "expired");
    store.notify(ac.id, "login", "expired");
    store.notify(bc.id, "login", "other private");
    store.notify(null, "backup", "system private");
    assert.equal(store.notices(user).length, 1);
    store.resolveNotice(ac.id, "login");
    assert.equal(store.notices(user)[0].resolved, 1);
    store.audit("admin", "拒绝绑定", a.id, ac.id, { reason: "测试原因" });
    assert.equal(JSON.parse(store.audits()[0].details).reason, "测试原因");
  } finally {
    store.close();
  }
});
test("queue deduplicates, serializes profiles, recovers jobs and checks current authority", async () => {
  const { store, ac, bc, user, b } = fixture();
  let called = [];
  const c = {
    busy: true,
    checking: null,
    bindings: new Map(),
    startLoginCheck: async (id) => {
      called.push(id);
      return { result: "valid", message: "ok" };
    },
    close: async () => {},
  };
  const jobs = new Jobs(store, c);
  clearInterval(jobs.timer);
  try {
    const job = jobs.enqueue("check", ac, user);
    assert.equal(jobs.enqueue("check", ac, user).id, job.id);
    await jobs.tick();
    assert.deepEqual(called, []);
    c.busy = false;
    await jobs.tick();
    assert.deepEqual(called, [ac.id]);
    assert.equal(jobs.list(user)[0].status, "success");
    const other = jobs.enqueue("check", bc, null);
    assert.ok(!jobs.list(user).some((j) => j.id === other.id));
    await assert.rejects(() => jobs.cancel(other.id, user), /无权/);
    await jobs.tick();
    const changed = jobs.enqueue("check", ac, user);
    store.updateAccount(ac.id, { anchor_id: b.id });
    await jobs.tick();
    assert.equal(
      store.db.prepare("SELECT status FROM jobs WHERE id=?").get(changed.id)
        .status,
      "error",
    );
    assert.equal(called.length, 2);
    const recover = jobs.enqueue("check", bc, null);
    store.db
      .prepare("UPDATE jobs SET status='running' WHERE id=?")
      .run(recover.id);
    store.recover();
    assert.equal(
      store.db.prepare("SELECT status FROM jobs WHERE id=?").get(recover.id)
        .status,
      "queued",
    );
    await jobs.tick();
    assert.equal(called.length, 3);
  } finally {
    await jobs.close();
    store.close();
  }
});
test("transient sync failures retry with a delay and stop after three attempts", async () => {
  const { store, ac, user } = fixture();
  let calls = 0;
  const c = {
    bindings: new Map(),
    startSync() {
      calls++;
      const id = store.startRun(ac.id, "2026-09-01", "2026-09-01", "manual");
      store.endRun(id, "error", "网络加载超时");
      store.updateAccount(ac.id, { status: "error" });
      this.task = Promise.resolve();
    },
    close: async () => {},
  };
  const jobs = new Jobs(store, c);
  clearInterval(jobs.timer);
  try {
    const job = jobs.enqueue("sync", store.account(ac.id), user);
    const row = () =>
      store.db.prepare("SELECT * FROM jobs WHERE id=?").get(job.id);
    await jobs.tick();
    assert.equal(row().status, "queued");
    assert.ok(row().available_at > Date.now());
    await jobs.tick();
    assert.equal(calls, 1);
    for (let i = 0; i < 2; i++) {
      store.db.prepare("UPDATE jobs SET available_at=0 WHERE id=?").run(job.id);
      await new Promise((r) => setTimeout(r, 5));
      await jobs.tick();
    }
    assert.equal(calls, 3);
    assert.equal(row().status, "error");
    assert.equal(row().attempts, 3);
  } finally {
    await jobs.close();
    store.close();
  }
});
test("today snapshots update totals without finalizing the day and remain eligible after midnight", async () => {
  const { store, ac, user } = fixture();
  const today = chinaDate();
  const jobs = new Jobs(store, { bindings: new Map(), close: async () => {} });
  clearInterval(jobs.timer);
  try {
    const session = {
      roomId: "today-fixture",
      title: "today",
      start: today + " 10:00:00",
      end: today + " 11:00:00",
      date: today,
      duration: 3600,
      followers: 1,
      gifters: 2,
    };
    store.saveDay(ac.id, today, [session]);
    store.saveDay(ac.id, today, [{ ...session, followers: 3 }]);
    const report = store.report(today.slice(0, 7), "", ac.id);
    assert.equal(report.totals.followers, 3);
    assert.equal(report.totals.sessions, 1);
    assert.equal(
      report.daily.find((d) => d.date === today).state,
      "provisional",
    );
    assert.equal(
      store.db
        .prepare("SELECT finalized FROM coverage WHERE account_id=? AND date=?")
        .get(ac.id, today).finalized,
      0,
    );
    assert.ok(
      store
        .automaticRanges(ac.id, shiftDate(today, 5))
        .some((r) => r.from <= today && r.to >= today),
    );
    assert.equal(
      jobs.enqueue("sync", store.account(ac.id), user, {
        from: today,
        to: today,
      }).status,
      "queued",
    );
    assert.throws(
      () =>
        jobs.enqueue("sync", store.account(ac.id), user, {
          from: today,
          to: shiftDate(today, 1),
        }),
      /截至今天/,
    );
    const past = shiftDate(today, -1);
    const record = {
      ...session,
      roomId: "past-fixture",
      date: past,
      start: past + " 10:00:00",
      end: past + " 11:00:00",
    };
    store.saveDay(ac.id, past, [record], false);
    assert.notEqual(
      store
        .report(past.slice(0, 7), "", ac.id)
        .daily.find((d) => d.date === past).state,
      "complete",
    );
    store.saveDay(ac.id, past, [record]);
    assert.equal(
      store
        .report(past.slice(0, 7), "", ac.id)
        .daily.find((d) => d.date === past).state,
      "complete",
    );
  } finally {
    await jobs.close();
    store.close();
  }
});
test("realtime cadence honors enablement, interval and persisted last enqueue time", () => {
  const s = {
    enabled: true,
    realtimeEnabled: true,
    intervalMinutes: 5,
    lastRealtimeAt: "2026-09-07T10:00:00Z",
  };
  assert.equal(realtimeDue(s, new Date("2026-09-07T10:04:59Z")), false);
  assert.equal(realtimeDue(s, new Date("2026-09-07T10:05:00Z")), true);
  assert.equal(
    realtimeDue({ ...s, enabled: false }, new Date("2026-09-07T11:00:00Z")),
    false,
  );
  assert.equal(
    realtimeDue(
      { ...s, realtimeEnabled: false },
      new Date("2026-09-07T11:00:00Z"),
    ),
    false,
  );
});
test("account deletion clears dependent data atomically and preserves other accounts and audit", async () => {
  const { store, ac, bc, user } = fixture();
  const jobs = new Jobs(store, { bindings: new Map(), close: async () => {} });
  clearInterval(jobs.timer);
  try {
    store.saveDay(ac.id, "2026-09-01", [
      {
        roomId: "delete-fixture",
        date: "2026-09-01",
        start: "2026-09-01 10:00:00",
        end: "2026-09-01 11:00:00",
        title: "fixture",
        duration: 3600,
        followers: 2,
        gifters: 1,
      },
    ]);
    store.saveDay(bc.id, "2026-09-01", []);
    const job = jobs.enqueue("check", ac, user);
    store.db.prepare("UPDATE jobs SET status='running' WHERE id=?").run(job.id);
    assert.throws(() => store.deleteAccount(ac.id, "admin"), /正在执行/);
    assert.ok(store.account(ac.id));
    store.db.prepare("UPDATE jobs SET status='queued' WHERE id=?").run(job.id);
    store.notify(ac.id, "fixture", "fixture");
    store.saveLoginCheck(ac.id, "valid", "fixture");
    store.deleteAccount(ac.id, "admin");
    assert.equal(store.account(ac.id), undefined);
    assert.ok(store.account(bc.id));
    assert.equal(store.report("2026-09").totals.sessions, 0);
    assert.equal(store.db.prepare("PRAGMA foreign_key_check").all().length, 0);
    assert.equal(store.audits()[0].action, "删除抖音号");
    assert.ok(
      store.createAccount({ anchorId: bc.anchor_id, handle: ac.handle }),
    );
  } finally {
    await jobs.close();
    store.close();
  }
});
test("verified backup restores exact data into a new database and refuses tampering", () => {
  const { store, dir, ac } = fixture();
  try {
    store.saveDay(ac.id, "2026-09-01", [
      {
        roomId: "1234567890123456789",
        title: "fixture",
        start: "2026-09-01 12:00:00",
        end: "2026-09-01 13:00:00",
        date: "2026-09-01",
        duration: 3600,
        followers: 2,
        gifters: 3,
      },
    ]);
    const backups = new Backups(store, dir);
    const result = backups.create();
    assert.equal(result.counts.sessions, 1);
    assert.equal(backups.verify(result.name).ok, true);
    const output = path.join(dir, "restored.sqlite");
    execFileSync(
      process.execPath,
      [
        "--experimental-sqlite",
        "scripts/restore.mjs",
        backups.file(result.name),
        output,
      ],
      { cwd: process.cwd(), windowsHide: true },
    );
    const restored = new DatabaseSync(output, { readOnly: true });
    assert.equal(
      restored.prepare("SELECT duration FROM sessions").get().duration,
      3600,
    );
    assert.equal(
      restored.prepare("SELECT COUNT(*) n FROM auth_sessions").get().n,
      0,
    );
    restored.close();
    assert.throws(() =>
      execFileSync(
        process.execPath,
        [
          "--experimental-sqlite",
          "scripts/restore.mjs",
          backups.file(result.name),
          output,
        ],
        { stdio: "pipe", windowsHide: true },
      ),
    );
    const manifest = backups.file(result.name) + ".json";
    const original = JSON.parse(readFileSync(manifest));
    writeFileSync(manifest, JSON.stringify({ ...original, sha256: "bad" }));
    assert.throws(() => backups.verify(result.name), /校验值/);
    backups.lastDay = "";
    backups.daily();
    assert.equal(backups.list().length, 2);
    assert.equal(backups.verify(backups.list()[0].name).ok, true);
  } finally {
    store.close();
  }
});
test("remote verification relays user pointer and keyboard actions only into the active official session", async () => {
  const browser = await chromium.launch({
    headless: true,
    channel: process.platform === "win32" ? "msedge" : undefined,
  });
  const context = await browser.newContext({
    viewport: { width: 1440, height: 1000 },
  });
  const c = new Collector(null, "unused");
  try {
    const page = await context.newPage();
    await page.route("https://anchor.douyin.com/login", (r) =>
      r.fulfill({
        contentType: "text/html",
        body: '<input style="position:absolute;left:10px;top:10px;width:200px;height:40px"/><div id="drag" style="position:absolute;left:10px;top:100px;width:300px;height:100px" onpointerdown="this.dataset.down=1" onpointerup="this.dataset.up=1"></div>',
      }),
    );
    await page.goto("https://anchor.douyin.com/login");
    c.bindings.set("fixture", { page, context });
    await c.verificationInput("fixture", {
      type: "pointer",
      from: { x: 50, y: 30 },
      to: { x: 50, y: 30 },
    });
    await c.verificationInput("fixture", { type: "text", text: "123456" });
    assert.equal(await page.locator("input").inputValue(), "123456");
    await c.verificationInput("fixture", {
      type: "pointer",
      from: { x: 20, y: 120 },
      to: { x: 200, y: 120 },
    });
    assert.equal(await page.locator("#drag").getAttribute("data-up"), "1");
    assert.ok((await c.verificationImage("fixture")).length > 1000);
    await assert.rejects(
      () => c.verificationInput("fixture", { type: "key", key: "F12" }),
      /不支持/,
    );
    await assert.rejects(
      () =>
        c.verificationInput("fixture", {
          type: "pointer",
          from: { x: -1, y: 0 },
          to: { x: 0, y: 0 },
        }),
      /无效/,
    );
    await page.goto("about:blank");
    assert.throws(() => c.verificationPage("fixture"), /官方页面/);
  } finally {
    await browser.close();
  }
});
