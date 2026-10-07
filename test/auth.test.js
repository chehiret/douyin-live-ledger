import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { Store } from "../server/store.js";
import { Auth } from "../server/auth.js";
import { Collector } from "../server/collector.js";

test("six-character passwords work for creation, reset and change; five are rejected", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "ledger-password-"));
  const store = new Store(":memory:");
  try {
    const auth = new Auth(store, dir);
    const anchor = store.saveAnchor({ name: "Password fixture" });
    const input = { username: "six-char", anchorId: anchor.id, enabled: true };
    assert.throws(() => auth.save({ ...input, password: "abc12" }), /6至128/);
    const user = auth.save({ ...input, password: "abc123" });
    assert.throws(
      () => auth.save({ ...input, password: "def45" }, user.id),
      /6至128/,
    );
    auth.save({ ...input, password: "def456" }, user.id);
    assert.throws(
      () =>
        auth.changePassword(user, {
          currentPassword: "def456",
          password: "ghi78",
        }),
      /6至128/,
    );
    auth.changePassword(user, {
      currentPassword: "def456",
      password: "ghi789",
    });
    auth.changePassword(user, {
      currentPassword: "ghi789",
      password: "abc123",
    });
  } finally {
    store.close();
  }
});

test("password hashing, session expiry, logout, reset and account disabling", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "ledger-auth-"));
  const store = new Store(path.join(dir, "test.sqlite"));
  try {
    const auth = new Auth(store, dir);
    const a = store.saveAnchor({ name: "first" });
    const b = store.saveAnchor({ name: "second" });
    const user = auth.save({
      username: "test-user",
      password: "Original-password-123",
      anchorId: a.id,
      enabled: true,
      role: "admin",
    });
    assert.equal(user.role, "anchor");
    assert.ok(!JSON.stringify(auth.list()).includes("password"));
    const hash = store.db
      .prepare("SELECT password_hash FROM users WHERE id=?")
      .get(user.id).password_hash;
    assert.ok(!hash.includes("Original-password"));
    function login(password, address = "fixture") {
      const result = {
        statusCode: 200,
        status(code) {
          this.statusCode = code;
          return this;
        },
        json(body) {
          this.body = body;
          return this;
        },
        clearCookie() {},
        cookie(name, value, options) {
          this.cookieValue = value;
          this.cookieOptions = options;
        },
      };
      auth.login(
        {
          body: { username: "test-user", password },
          socket: { remoteAddress: address },
          headers: {},
          secure: true,
        },
        result,
      );
      return result;
    }
    assert.equal(login("bad").statusCode, 401);
    const session = login("Original-password-123");
    assert.equal(session.statusCode, 200);
    assert.equal(session.cookieOptions.httpOnly, true);
    assert.equal(session.cookieOptions.sameSite, "strict");
    assert.equal(session.cookieOptions.secure, true);
    const req = {
      headers: { cookie: `ledger_session=${session.cookieValue}` },
    };
    assert.equal(auth.user(req).anchor_id, a.id);
    assert.notEqual(
      store.db.prepare("SELECT token_hash FROM auth_sessions").get().token_hash,
      session.cookieValue,
    );
    auth.save(
      {
        username: "test-user",
        password: "Reset-password-123",
        enabled: true,
        anchorId: b.id,
      },
      user.id,
    );
    assert.equal(auth.user(req), undefined);
    assert.equal(auth.list().find((u) => u.id === user.id).anchor_id, a.id);
    assert.equal(login("Original-password-123").statusCode, 401);
    const reset = login("Reset-password-123");
    const resetReq = {
      headers: { cookie: `ledger_session=${reset.cookieValue}` },
    };
    assert.throws(
      () =>
        auth.changePassword(user, {
          currentPassword: "wrong",
          password: "Changed-password-123",
        }),
      /当前密码/,
    );
    auth.changePassword(user, {
      currentPassword: "Reset-password-123",
      password: "Changed-password-123",
    });
    assert.equal(auth.user(resetReq), undefined);
    const changed = login("Changed-password-123");
    const changedReq = {
      headers: { cookie: `ledger_session=${changed.cookieValue}` },
    };
    store.db.prepare("UPDATE auth_sessions SET expires_at=0").run();
    assert.equal(auth.user(changedReq), undefined);
    const active = login("Changed-password-123");
    auth.logout(
      { headers: { cookie: `ledger_session=${active.cookieValue}` } },
      { clearCookie() {} },
    );
    assert.equal(
      auth.user({
        headers: { cookie: `ledger_session=${active.cookieValue}` },
      }),
      undefined,
    );
    auth.save({ username: "test-user", enabled: false }, user.id);
    assert.equal(login("Changed-password-123").statusCode, 401);
    for (let i = 0; i < 10; i++) login("wrong", "rate-limit");
    assert.equal(login("wrong", "rate-limit").statusCode, 401);
    auth.save({ username: "test-user", enabled: true }, user.id);
    assert.equal(login("Changed-password-123", "rate-limit").statusCode, 200);
    const initial = readFileSync(path.join(dir, "initial-admin.txt"), "utf8");
    new Auth(store, dir);
    assert.equal(
      readFileSync(path.join(dir, "initial-admin.txt"), "utf8"),
      initial,
    );
  } finally {
    store.close();
  }
});

test("sync filters ownership and approval; binding uses immutable identity and rejects duplicates", async () => {
  const store = new Store(":memory:");
  const c = new Collector(store, "unused");
  try {
    const a = store.saveAnchor({ name: "one" }),
      b = store.saveAnchor({ name: "two" });
    const own = store.createAccount({ anchorId: a.id, handle: "own" }),
      other = store.createAccount({ anchorId: b.id, handle: "other" }),
      pending = store.createAccount({ anchorId: a.id, handle: "pending" });
    for (const account of [own, other, pending])
      store.updateAccount(account.id, { status: "ready" });
    store.updateAccount(pending.id, { approval: "pending" });
    const collected = [];
    c.collectAccount = async (account) => {
      collected.push(account.id);
    };
    c.startSync({ anchorId: a.id });
    await c.task;
    assert.deepEqual(collected, [own.id]);
    assert.throws(
      () => c.startSync({ anchorId: a.id, accountId: other.id }),
      /没有可同步/,
    );
    store.updateAccount(own.id, {
      nickname: "old nickname",
      douyin_uid: "1234567890123456789",
    });
    const page = {
      url: () => "https://anchor.douyin.com/anchor/review",
      isClosed: () => false,
    };
    c.identities.set(page, "9876543210987654321");
    c.nickname = async () => "old nickname";
    c.bindings.set(own.id, {
      page,
      created: Date.now(),
      context: { close: async () => {} },
    });
    await c.pollBinding(own.id);
    assert.equal(c.bindings.get(own.id).phase, "mismatch");
    c.identities.set(page, "1234567890123456789");
    c.nickname = async () => "new nickname";
    await c.pollBinding(own.id);
    assert.equal(store.account(own.id).nickname, "new nickname");
    assert.equal(c.bindings.has(own.id), false);
    assert.match(c.identityConflict(other, page), /已被绑定/);
    c.identities.delete(page);
    assert.match(c.identityConflict(own, page), /无法确认/);
  } finally {
    await c.close();
    store.close();
  }
});
