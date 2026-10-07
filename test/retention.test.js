import test from "node:test";
import assert from "node:assert/strict";
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  utimesSync,
  existsSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { Store } from "../server/store.js";
import { Guarantees } from "../server/guarantees.js";
import { Backups } from "../server/backups.js";
import {
  retentionStart,
  chinaDate,
  shiftDate,
  validateCollectionRange,
} from "../server/domain.js";
import { cleanupFiles } from "../server/retention.js";

const row = (id, date) => ({
  roomId: id,
  date,
  title: "历史场次",
  start: date + " 12:00:00",
  end: date + " 13:00:00",
  duration: 3600,
  followers: 1,
  gifters: 2,
  fanclub: 3,
  commenters: 4,
  exposure: 100,
  entrants: 10,
  entry_rate: 10,
});
test("retention follows three Shanghai calendar months including year and leap boundaries", () => {
  assert.equal(retentionStart("2026-09-08"), "2026-07-01");
  assert.equal(retentionStart("2026-01-31"), "2025-11-01");
  assert.equal(retentionStart("2024-04-30"), "2024-02-01");
  assert.equal(
    retentionStart(chinaDate(new Date("2026-08-31T15:59:59Z"))),
    "2026-06-01",
  );
  assert.equal(
    retentionStart(chinaDate(new Date("2026-08-31T16:00:00Z"))),
    "2026-07-01",
  );
  assert.doesNotThrow(() =>
    validateCollectionRange("2024-01-01", "2024-01-31", "2026-09-08"),
  );
  assert.throws(
    () => validateCollectionRange("2026-01-01", "2026-09-08", "2026-09-08"),
    /100天/,
  );
  assert.throws(
    () => validateCollectionRange("2026-09-09", "2026-09-09", "2026-09-08"),
    /截至今天/,
  );
});

test("cleanup deletes old broadcasts and coverage, retains exact boundary and settings, and compacts once per day", () => {
  const s = new Store(":memory:"),
    g = new Guarantees(s);
  try {
    const anchor = s.saveAnchor({ name: "保留测试" }),
      account = s.createAccount({ anchorId: anchor.id, handle: "retention" });
    g.set(anchor.id, "2026-06", 7200, "admin");
    s.saveDay(account.id, "2026-06-30", [row("old", "2026-06-30")]);
    s.saveDay(account.id, "2026-07-01", [row("boundary", "2026-07-01")]);
    const tracking = s.account(account.id).tracking_from;
    s.retentionEnabled = true;
    s.cleanupLive(new Date("2026-09-08T00:00:00Z"));
    assert.equal(s.db.prepare("SELECT COUNT(*) n FROM sessions").get().n, 1);
    assert.equal(
      s.db.prepare("SELECT date FROM coverage").get().date,
      "2026-07-01",
    );
    assert.equal(
      s.db.prepare("SELECT seconds FROM monthly_guarantees").get().seconds,
      7200,
    );
    assert.equal(s.account(account.id).tracking_from, tracking);
    assert.ok(
      s
        .automaticRanges(account.id, "2026-09-08")
        .every((r) => r.from >= "2026-07-01"),
    );
    assert.equal(
      s.db.prepare("PRAGMA integrity_check").get().integrity_check,
      "ok",
    );
    s.cleanupLive(new Date("2026-09-08T01:00:00Z"));
    assert.equal(
      s.db
        .prepare("SELECT value FROM settings WHERE key='last_storage_compact'")
        .get().value,
      "2026-09-08",
    );
    s.cleanupLive(new Date("2026-10-01T00:00:00Z"));
    assert.equal(s.db.prepare("SELECT COUNT(*) n FROM sessions").get().n, 0);
  } finally {
    s.close();
  }
});

test("online history is scoped, deduplicated, expires in 30 minutes, and never enters disk or backups", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "ledger-retention-"));
  const file = path.join(dir, "live.sqlite"),
    s = new Store(file);
  try {
    const a = s.saveAnchor({ name: "自己" }),
      b = s.saveAnchor({ name: "其他" });
    const x = s.createAccount({ anchorId: a.id, handle: "old-x" }),
      y = s.createAccount({ anchorId: b.id, handle: "old-y" });
    s.retentionEnabled = true;
    const date = shiftDate(retentionStart(), -1),
      month = date.slice(0, 7);
    const sessions = [row("old-1", date), row("old-2", date)];
    s.saveDay(x.id, date, sessions);
    s.saveDay(x.id, date, sessions);
    s.saveDay(y.id, date, [row("foreign", date)]);
    assert.equal(s.db.prepare("PRAGMA temp_store").get().temp_store, 2);
    assert.equal(
      s.db.prepare("SELECT COUNT(*) n FROM main.sessions").get().n,
      0,
    );
    assert.equal(
      s.db.prepare("SELECT COUNT(*) n FROM main.coverage").get().n,
      0,
    );
    let r = s.report(month, [a.id]);
    assert.equal(r.totals.duration, 7200);
    assert.equal(r.sessions.length, 2);
    assert.equal(r.coverage.length, 1);
    assert.equal(r.allTime.duration, 0);
    assert.equal(r.daily.find((d) => d.date === date).state, "complete");
    assert.ok(r.daily.some((d) => d.state === "online_required"));
    assert.equal(s.report(month, []).sessions.length, 0);
    assert.throws(() => s.saveDay(y.id, date, sessions), /另一个抖音号/);
    const backup = new Backups(s, dir).create();
    const copy = new DatabaseSync(path.join(dir, "backups", backup.name), {
      readOnly: true,
    });
    assert.equal(copy.prepare("SELECT COUNT(*) n FROM sessions").get().n, 0);
    assert.equal(
      copy
        .prepare(
          "SELECT COUNT(*) n FROM sqlite_master WHERE name LIKE 'online_%'",
        )
        .get().n,
      0,
    );
    copy.close();
    s.expireOnline(new Date(Date.now() + 31 * 60000));
    r = s.report(month, [a.id]);
    assert.equal(r.sessions.length, 0);
    assert.ok(r.daily.every((d) => d.state === "online_required"));
    s.saveDay(x.id, date, sessions);
    s.deleteAccount(x.id, "admin");
    assert.equal(
      s.db
        .prepare("SELECT COUNT(*) n FROM online_sessions WHERE account_id=?")
        .get(x.id).n,
      0,
    );
  } finally {
    s.close();
  }
  const reopened = new Store(file);
  assert.equal(
    reopened.db.prepare("SELECT COUNT(*) n FROM online_sessions").get().n,
    0,
  );
  reopened.close();
});

test("diagnostic and runtime log files expire after seven days without touching profiles or unrelated files", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "ledger-log-retention-")),
    now = new Date("2026-09-08T12:00:00Z");
  for (const name of ["diagnostics", "runtime-logs", "profiles"])
    mkdirSync(path.join(dir, name));
  const old = new Date("2026-09-01T11:59:59Z"),
    boundary = new Date("2026-09-01T12:00:00Z");
  const write = (name, time) => {
    const file = path.join(dir, name);
    writeFileSync(file, "keep or remove");
    utimesSync(file, time, time);
    return file;
  };
  const expired = write(
    "diagnostics/11111111-1111-1111-1111-111111111111.png",
    old,
  );
  const retained = write(
    "diagnostics/22222222-2222-2222-2222-222222222222-requests.json",
    boundary,
  );
  const unrelated = write("diagnostics/user-notes.json", old),
    profile = write("profiles/Cookies", old);
  const log = write("runtime-logs/server-2026-08-30.log", old);
  cleanupFiles(dir, now);
  assert.equal(existsSync(expired), false);
  assert.equal(existsSync(log), false);
  assert.equal(existsSync(retained), true);
  assert.equal(existsSync(unrelated), true);
  assert.equal(existsSync(profile), true);
});
