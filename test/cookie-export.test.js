import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { Store } from "../server/store.js";
import { Collector } from "../server/collector.js";
import { Jobs } from "../server/jobs.js";
import { cookieEditorCookies } from "../server/cookie-export.js";

test("Cookie-Editor format preserves scoped and session cookies and excludes expired/foreign domains", () => {
  const cookie = {
    name: "sessionid",
    value: "synthetic-only",
    domain: ".douyin.com",
    path: "/",
    secure: true,
    httpOnly: true,
    sameSite: "None",
    expires: 2000,
  };
  const result = cookieEditorCookies(
    [
      cookie,
      {
        ...cookie,
        name: "host",
        domain: "anchor.douyin.com",
        path: "/anchor",
        sameSite: "Strict",
        expires: -1,
      },
      { ...cookie, name: "lax", sameSite: "Lax", expires: 0 },
      { ...cookie, name: "expired", expires: 999 },
      { ...cookie, domain: "douyin.com.example.org" },
      { ...cookie, domain: "notdouyin.com" },
      { ...cookie, domain: "example.org" },
    ],
    1000,
  );
  assert.equal(result.length, 3);
  assert.equal(result[0].expirationDate, 2000);
  assert.equal(result[0].sameSite, "no_restriction");
  assert.equal(result[0].hostOnly, false);
  assert.equal(result[0].httpOnly, true);
  assert.equal(result[0].session, false);
  assert.equal(result[1].hostOnly, true);
  assert.equal(result[1].sameSite, "strict");
  assert.equal(result[1].path, "/anchor");
  assert.equal(result[1].session, true);
  assert.ok(!Object.hasOwn(result[1], "expirationDate"));
  assert.equal(result[2].sameSite, "lax");
});

test("export reserves the profile, blocks queued/direct browser work, and releases it after success and failures", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "ledger-cookie-lock-"));
  const store = new Store(":memory:");
  const anchor = store.saveAnchor({ name: "Cookie test" });
  const a = store.createAccount({ anchorId: anchor.id });
  const b = store.createAccount({ anchorId: anchor.id });
  mkdirSync(path.join(dir, "profiles", a.id), { recursive: true });
  const collector = new Collector(store, dir);
  const jobs = new Jobs(store, collector);
  clearInterval(jobs.timer);
  let release,
    closed = 0,
    picked = 0;
  try {
    collector.launch = async (id) => {
      assert.equal(id, a.id);
      return {
        cookies: () =>
          new Promise((resolve) => {
            release = resolve;
          }),
        close: async () => {
          closed++;
        },
      };
    };
    const pending = collector.exportCookies(a.id);
    assert.equal(collector.exporting, a.id);
    assert.throws(() => collector.exportCookies(a.id), /任务结束/);
    assert.throws(() => collector.startLoginCheck(b.id), /已有/);
    assert.throws(() => collector.startSync(), /已有/);
    await assert.rejects(() => collector.startBinding(b.id), /稍后再试/);
    const queued = jobs.enqueue("login", b, null);
    jobs.execute = async () => {
      picked++;
    };
    await jobs.tick();
    assert.equal(picked, 0);
    assert.equal(
      store.db.prepare("SELECT status FROM jobs WHERE id=?").get(queued.id)
        .status,
      "queued",
    );
    release([
      {
        name: "sessionid",
        value: "fake-A",
        domain: ".douyin.com",
        path: "/",
        expires: -1,
        sameSite: "Lax",
        secure: true,
        httpOnly: true,
      },
    ]);
    assert.equal((await pending)[0].value, "fake-A");
    assert.equal(closed, 1);
    assert.equal(collector.exporting, null);
    await jobs.tick();
    assert.equal(picked, 1);
    assert.equal(store.account(a.id).status, "unbound");
    assert.equal(store.runs().length, 0);
    collector.launch = async () => {
      throw new Error("launch failed");
    };
    await assert.rejects(() => collector.exportCookies(a.id), /launch failed/);
    assert.equal(collector.exporting, null);
    collector.launch = async () => ({
      cookies: async () => [],
      close: async () => {
        closed++;
      },
    });
    await assert.rejects(() => collector.exportCookies(a.id), /没有可导出/);
    assert.equal(closed, 2);
    assert.equal(collector.exporting, null);
    assert.throws(() => collector.exportCookies(b.id), /没有保存的登录环境/);
    collector.busy = true;
    assert.throws(() => collector.exportCookies(a.id), /任务结束/);
    collector.busy = false;
    collector.launch = async () => ({
      cookies: async () => {
        throw new Error("cookie read failed");
      },
      close: async () => {
        closed++;
      },
    });
    await assert.rejects(
      () => collector.exportCookies(a.id),
      /cookie read failed/,
    );
    assert.equal(closed, 3);
    assert.equal(collector.exporting, null);
  } finally {
    await jobs.close();
    store.close();
  }
});
