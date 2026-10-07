import test from "node:test";
import assert from "node:assert/strict";
import { Store } from "../server/store.js";
import { Collector } from "../server/collector.js";
import { Jobs } from "../server/jobs.js";

test("new accounts need no manual handle; automatic identity is verified before saving", async () => {
  const s = new Store(":memory:"),
    a = s.saveAnchor({ name: "主播" });
  const first = s.createAccount({ anchorId: a.id }),
    second = s.createAccount({ anchorId: a.id });
  const c = new Collector(s, "unused");
  try {
    assert.notEqual(first.id, second.id);
    assert.equal(first.handle, "");
    assert.equal(second.handle, "");
    assert.ok(s.listAccounts().every((x) => !x.handle));
    const page = {
      url: () => "https://anchor.douyin.com/anchor/review",
      isClosed: () => false,
    };
    let closed = false;
    c.nickname = async () => "官方昵称";
    c.bindings.set(first.id, {
      page,
      context: {
        close: async () => {
          closed = true;
        },
      },
      created: Date.now(),
    });
    await c.pollBinding(first.id);
    assert.equal(closed, false);
    assert.equal(s.account(first.id).nickname, "");
    c.identities.set(page, "1234567890123456789");
    c.handles.set(page, "official_123");
    await c.pollBinding(first.id);
    assert.equal(closed, true);
    assert.equal(s.account(first.id).nickname, "官方昵称");
    assert.equal(s.account(first.id).douyin_handle, "official_123");
    assert.equal(s.account(first.id).douyin_uid, "1234567890123456789");
    assert.equal(c.bindingStatus(first.id).phase, "ready");
    c.bindings.set(second.id, {
      page,
      context: { close: async () => {} },
      created: Date.now(),
    });
    await c.pollBinding(second.id);
    assert.equal(c.bindingStatus(second.id).phase, "mismatch");
    const blockedFrame = await c.verificationFrame(second.id);
    assert.equal(blockedFrame.phase, "mismatch");
    assert.equal(blockedFrame.image, undefined);
    assert.equal(s.account(second.id).douyin_uid, "");
    c.identities.set(page, "9876543210123456789");
    c.handles.delete(page);
    await c.pollBinding(second.id);
    assert.equal(s.account(second.id).nickname, "官方昵称");
    assert.equal(s.account(second.id).douyin_handle, "");
  } finally {
    await c.close();
    s.close();
  }
});

test("login does not publish ready until persistent browser close has finished; dashboard is never a verification frame", async () => {
  const s = new Store(":memory:");
  const a = s.saveAnchor({ name: "保存测试" });
  const account = s.createAccount({ anchorId: a.id });
  const c = new Collector(s, "unused");
  let release;
  const closed = new Promise((resolve) => {
    release = resolve;
  });
  const page = {
    url: () => "https://anchor.douyin.com/anchor/review",
    isClosed: () => false,
  };
  c.nickname = async () => "官方昵称";
  c.handles.set(page, "official_name");
  c.identities.set(page, "1234567890123456789");
  c.bindings.set(account.id, {
    page,
    context: { close: () => closed },
    created: Date.now(),
    phase: "verification",
  });
  try {
    const pending = c.pollBinding(account.id);
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(c.bindingStatus(account.id).phase, "finishing");
    assert.notEqual(s.account(account.id).status, "ready");
    const frame = await c.verificationFrame(account.id);
    assert.equal(frame.phase, "finishing");
    assert.equal(frame.image, undefined);
    release();
    await pending;
    assert.equal(c.bindingStatus(account.id).phase, "ready");
    assert.equal(s.account(account.id).douyin_uid, "1234567890123456789");
    assert.equal(c.bindings.has(account.id), false);
  } finally {
    release();
    await c.close();
    s.close();
  }
});

test("queued login precedes background sync and an existing binding is not hidden by another queued request", async () => {
  const s = new Store(":memory:"),
    anchor = s.saveAnchor({ name: "主播" });
  const a = s.createAccount({ anchorId: anchor.id }),
    b = s.createAccount({ anchorId: anchor.id });
  s.updateAccount(a.id, { status: "ready" });
  const c = {
    bindings: new Map(),
    busy: false,
    checking: null,
    close: async () => {},
    bindingStatus: () => ({ phase: "waiting", canShow: true }),
  };
  const jobs = new Jobs(s, c);
  clearInterval(jobs.timer);
  try {
    const sync = jobs.enqueue("sync", s.account(a.id), null);
    const login = jobs.enqueue("login", b, null);
    let selected;
    jobs.execute = async (j) => {
      selected = j;
    };
    await jobs.tick();
    assert.equal(selected.id, login.id);
    assert.equal(jobs.loginStatus(b.id).phase, "queued");
    s.db.prepare("UPDATE jobs SET status='running' WHERE id=?").run(sync.id);
    assert.match(jobs.loginStatus(b.id).message, /当前同步/);
    c.bindings.set(b.id, {});
    assert.equal(jobs.loginStatus(b.id).phase, "waiting");
    assert.equal(jobs.loginStatus(b.id).canShow, true);
    assert.ok(
      !JSON.stringify(jobs.list({ role: "admin" })).includes("pending:"),
    );
  } finally {
    await jobs.close();
    s.close();
  }
});
