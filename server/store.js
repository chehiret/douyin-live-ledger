import { DatabaseSync } from "node:sqlite";
import { randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { scopeSql, inScope } from "./scope.js";
import { countKeys, metricLabels } from "../shared/metrics.js";
import {
  chinaDate,
  monthRange,
  shiftDate,
  datesBetween,
  trafficTotals,
  retentionStart,
} from "./domain.js";

export class Store {
  constructor(path) {
    if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
    this.db = new DatabaseSync(path);
    this.db
      .exec(`PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS anchors(id TEXT PRIMARY KEY,name TEXT NOT NULL,note TEXT NOT NULL DEFAULT '',created_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS accounts(id TEXT PRIMARY KEY,anchor_id TEXT NOT NULL REFERENCES anchors(id),handle TEXT NOT NULL UNIQUE,nickname TEXT NOT NULL DEFAULT '',note TEXT NOT NULL DEFAULT '',status TEXT NOT NULL DEFAULT 'unbound',enabled INTEGER NOT NULL DEFAULT 1,last_sync TEXT,error TEXT NOT NULL DEFAULT '',created_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS sessions(room_id TEXT PRIMARY KEY,account_id TEXT NOT NULL REFERENCES accounts(id),title TEXT NOT NULL,start TEXT NOT NULL,end TEXT NOT NULL,date TEXT NOT NULL,duration INTEGER NOT NULL CHECK(duration>=0),followers INTEGER NOT NULL CHECK(followers>=0),gifters INTEGER NOT NULL CHECK(gifters>=0),updated_at TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS sessions_date ON sessions(date,account_id);
      CREATE TABLE IF NOT EXISTS coverage(account_id TEXT NOT NULL REFERENCES accounts(id),date TEXT NOT NULL,checked_at TEXT NOT NULL,session_count INTEGER NOT NULL,PRIMARY KEY(account_id,date));
      CREATE TABLE IF NOT EXISTS runs(id TEXT PRIMARY KEY,account_id TEXT REFERENCES accounts(id),source TEXT NOT NULL,from_date TEXT NOT NULL,to_date TEXT NOT NULL,status TEXT NOT NULL,message TEXT NOT NULL DEFAULT '',session_count INTEGER NOT NULL DEFAULT 0,started_at TEXT NOT NULL,ended_at TEXT);
      CREATE TABLE IF NOT EXISTS settings(key TEXT PRIMARY KEY,value TEXT NOT NULL);`);
    this.db.exec(`CREATE TABLE IF NOT EXISTS login_checks(
      id INTEGER PRIMARY KEY AUTOINCREMENT, account_id TEXT NOT NULL REFERENCES accounts(id),
      result TEXT NOT NULL, message TEXT NOT NULL, checked_at TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS login_checks_account ON login_checks(account_id,id DESC);`);
    const anchorColumns = this.db
      .prepare("PRAGMA table_info(anchors)")
      .all()
      .map((c) => c.name);
    if (!anchorColumns.includes("is_leader"))
      this.db.exec(
        "ALTER TABLE anchors ADD COLUMN is_leader INTEGER NOT NULL DEFAULT 0 CHECK(is_leader IN (0,1))",
      );
    if (!anchorColumns.includes("leader_id"))
      this.db.exec(
        "ALTER TABLE anchors ADD COLUMN leader_id TEXT REFERENCES anchors(id)",
      );
    this.db.exec(
      "CREATE INDEX IF NOT EXISTS anchors_leader ON anchors(leader_id)",
    );
    const sessionColumns = this.db
      .prepare("PRAGMA table_info(sessions)")
      .all()
      .map((c) => c.name);
    for (const metric of ["fanclub", "commenters", "exposure", "entrants"])
      if (!sessionColumns.includes(metric))
        this.db.exec(
          `ALTER TABLE sessions ADD COLUMN ${metric} INTEGER CHECK(${metric}>=0)`,
        );
    if (!sessionColumns.includes("entry_rate"))
      this.db.exec(
        "ALTER TABLE sessions ADD COLUMN entry_rate REAL CHECK(entry_rate>=0 AND entry_rate<=100)",
      );
    if (!sessionColumns.includes("count_labels"))
      this.db.exec(
        "ALTER TABLE sessions ADD COLUMN count_labels TEXT NOT NULL DEFAULT '{}'",
      );
    if (!sessionColumns.includes("calendar_dates"))
      this.db.exec(
        "ALTER TABLE sessions ADD COLUMN calendar_dates TEXT NOT NULL DEFAULT '[]'",
      );
    if (
      !this.db
        .prepare("PRAGMA table_info(coverage)")
        .all()
        .some((c) => c.name === "finalized")
    )
      this.db.exec(
        "ALTER TABLE coverage ADD COLUMN finalized INTEGER NOT NULL DEFAULT 1",
      );
    const accountColumns = this.db
      .prepare("PRAGMA table_info(accounts)")
      .all()
      .map((c) => c.name);
    if (!accountColumns.includes("approval"))
      this.db.exec(
        "ALTER TABLE accounts ADD COLUMN approval TEXT NOT NULL DEFAULT 'approved'",
      );
    if (!accountColumns.includes("douyin_uid"))
      this.db.exec(
        "ALTER TABLE accounts ADD COLUMN douyin_uid TEXT NOT NULL DEFAULT ''",
      );
    if (!accountColumns.includes("douyin_handle"))
      this.db.exec(
        "ALTER TABLE accounts ADD COLUMN douyin_handle TEXT NOT NULL DEFAULT ''",
      );
    if (!accountColumns.includes("tracking_from")) {
      this.db.exec(
        "ALTER TABLE accounts ADD COLUMN tracking_from TEXT NOT NULL DEFAULT ''",
      );
      this.db.exec(
        "UPDATE accounts SET tracking_from=MIN(substr(created_at,1,7)||'-01',COALESCE((SELECT MIN(date) FROM coverage WHERE account_id=accounts.id),substr(created_at,1,7)||'-01'))",
      );
    }
    this.db
      .exec(`CREATE TABLE IF NOT EXISTS audit_events(id INTEGER PRIMARY KEY AUTOINCREMENT,actor TEXT NOT NULL,action TEXT NOT NULL,anchor_id TEXT,account_id TEXT,details TEXT NOT NULL,created_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS notices(id INTEGER PRIMARY KEY AUTOINCREMENT,account_id TEXT,kind TEXT NOT NULL,message TEXT NOT NULL,resolved INTEGER NOT NULL DEFAULT 0,created_at TEXT NOT NULL,updated_at TEXT NOT NULL);
      CREATE UNIQUE INDEX IF NOT EXISTS notices_active ON notices(COALESCE(account_id,''),kind) WHERE resolved=0;
      CREATE TABLE IF NOT EXISTS notice_reads(notice_id INTEGER NOT NULL,user_id TEXT NOT NULL,read_at TEXT NOT NULL,PRIMARY KEY(notice_id,user_id));
      CREATE TABLE IF NOT EXISTS jobs(id TEXT PRIMARY KEY,account_id TEXT NOT NULL REFERENCES accounts(id),actor_id TEXT,owner_anchor_id TEXT,kind TEXT NOT NULL,payload TEXT NOT NULL,dedupe TEXT NOT NULL,status TEXT NOT NULL,message TEXT NOT NULL DEFAULT '',created_at TEXT NOT NULL,started_at TEXT,ended_at TEXT);
      CREATE UNIQUE INDEX IF NOT EXISTS jobs_active ON jobs(dedupe) WHERE status IN ('queued','running');`);
    // Approval is retired. Preserve ownership, login state and manual pauses.
    // Keep the column for database/backward compatibility with report queries.
    this.db
      .exec(`UPDATE accounts SET approval='approved' WHERE approval!='approved';
      UPDATE notices SET resolved=1 WHERE kind='approval' AND resolved=0;`);
    const jobColumns = this.db
      .prepare("PRAGMA table_info(jobs)")
      .all()
      .map((c) => c.name);
    if (!jobColumns.includes("attempts"))
      this.db.exec(
        "ALTER TABLE jobs ADD COLUMN attempts INTEGER NOT NULL DEFAULT 0",
      );
    if (!jobColumns.includes("available_at"))
      this.db.exec(
        "ALTER TABLE jobs ADD COLUMN available_at INTEGER NOT NULL DEFAULT 0",
      );
    this.db.exec(
      "CREATE UNIQUE INDEX IF NOT EXISTS accounts_douyin_uid ON accounts(douyin_uid) WHERE douyin_uid!=''",
    );
    this.db.prepare("INSERT OR IGNORE INTO settings VALUES('schedule',?)").run(
      JSON.stringify({
        enabled: true,
        time: "04:00",
        lookback: 3,
        lastDate: null,
      }),
    );
    if (
      !this.db
        .prepare("SELECT 1 FROM settings WHERE key='six_hour_sync_v1'")
        .get()
    ) {
      this.db.exec("BEGIN IMMEDIATE");
      try {
        this.setSettings({
          intervalMinutes: 360,
          realtimeEnabled: true,
          lastRealtimeAt: new Date().toISOString(),
        });
        this.db
          .prepare("INSERT INTO settings VALUES('six_hour_sync_v1','done')")
          .run();
        this.db.exec("COMMIT");
      } catch (e) {
        this.db.exec("ROLLBACK");
        throw e;
      }
    }
    // Old online results live only in this process. They are excluded from backups.
    this.db.exec(`PRAGMA temp_store=MEMORY;
      CREATE TEMP TABLE online_sessions AS SELECT * FROM sessions WHERE 0;
      CREATE UNIQUE INDEX online_sessions_room ON online_sessions(room_id);
      CREATE TEMP TABLE online_coverage AS SELECT * FROM coverage WHERE 0;
      CREATE UNIQUE INDEX online_coverage_day ON online_coverage(account_id,date);
      CREATE TEMP VIEW report_sessions AS SELECT * FROM sessions UNION ALL SELECT * FROM online_sessions;
      CREATE TEMP VIEW report_coverage AS SELECT * FROM coverage UNION ALL SELECT * FROM online_coverage;
    `);
  }
  close() {
    this.db.close();
  }
  listAnchors() {
    return this.db
      .prepare(
        "SELECT a.*,COUNT(b.id) account_count FROM anchors a LEFT JOIN accounts b ON b.anchor_id=a.id GROUP BY a.id ORDER BY a.created_at",
      )
      .all();
  }
  anchor(id) {
    return this.db.prepare("SELECT * FROM anchors WHERE id=?").get(id);
  }
  saveAnchor(input, id = randomUUID()) {
    this.db
      .prepare(
        "INSERT INTO anchors(id,name,note,created_at) VALUES(?,?,?,?) ON CONFLICT(id) DO UPDATE SET name=excluded.name,note=excluded.note",
      )
      .run(id, input.name, input.note || "", new Date().toISOString());
    return this.anchor(id);
  }
  readScope(user) {
    if (user.role === "admin") return null;
    const anchor = this.anchor(user.anchor_id);
    if (!anchor) return [];
    return [
      anchor.id,
      ...(anchor.is_leader
        ? this.db
            .prepare("SELECT id FROM anchors WHERE leader_id=?")
            .all(anchor.id)
            .map((a) => a.id)
        : []),
    ];
  }
  setTeam(id, input, actor) {
    if (!this.anchor(id)) throw Error("主播不存在");
    if (
      typeof input.isLeader !== "boolean" ||
      typeof input.leaderId !== "string"
    )
      throw Error("分组设置不正确");
    const { isLeader, leaderId } = input;
    if (
      leaderId &&
      (isLeader || leaderId === id || !this.anchor(leaderId)?.is_leader)
    )
      throw Error("请选择有效组长；组长不能归属其他组长");
    if (
      !isLeader &&
      this.db.prepare("SELECT 1 FROM anchors WHERE leader_id=?").get(id)
    )
      throw Error("请先调整名下主播的归属，再取消组长身份");
    this.db
      .prepare("UPDATE anchors SET is_leader=?,leader_id=? WHERE id=?")
      .run(Number(isLeader), leaderId || null, id);
    this.audit(actor, "设置组长与归属", id, null, {
      组长: isLeader,
      归属组长: leaderId ? this.anchor(leaderId).name : "未分组",
    });
    return this.anchor(id);
  }
  listAccounts() {
    return this.db
      .prepare(
        "SELECT b.*,a.name anchor_name FROM accounts b JOIN anchors a ON a.id=b.anchor_id ORDER BY b.created_at",
      )
      .all()
      .map((account) => ({
        ...account,
        handle: account.handle.startsWith("pending:") ? "" : account.handle,
        login_checks: this.loginChecks(account.id),
      }));
  }
  loginChecks(accountId) {
    return this.db
      .prepare(
        "SELECT * FROM login_checks WHERE account_id=? ORDER BY id DESC LIMIT 10",
      )
      .all(accountId);
  }
  saveLoginCheck(accountId, result, message) {
    this.db
      .prepare(
        "INSERT INTO login_checks(account_id,result,message,checked_at) VALUES(?,?,?,?)",
      )
      .run(accountId, result, message, new Date().toISOString());
    if (result === "valid") this.resolveNotice(accountId, "login");
    else this.notify(accountId, "login", message);
    return this.loginChecks(accountId)[0];
  }
  account(id) {
    const account = this.db
      .prepare("SELECT * FROM accounts WHERE id=?")
      .get(id);
    if (account?.handle.startsWith("pending:")) account.handle = "";
    return account;
  }
  createAccount(input) {
    const id = randomUUID();
    this.db
      .prepare(
        "INSERT INTO accounts(id,anchor_id,handle,note,created_at,tracking_from) VALUES(?,?,?,?,?,?)",
      )
      .run(
        id,
        input.anchorId,
        input.handle || `pending:${id}`,
        input.note || "",
        new Date().toISOString(),
        input.trackingFrom || chinaDate().slice(0, 7) + "-01",
      );
    return this.account(id);
  }
  updateAccount(id, patch) {
    const allowed = [
      "anchor_id",
      "nickname",
      "note",
      "status",
      "enabled",
      "last_sync",
      "error",
      "approval",
      "douyin_uid",
      "douyin_handle",
      "tracking_from",
    ];
    const entries = Object.entries(patch).filter(([k]) => allowed.includes(k));
    if (entries.length)
      this.db
        .prepare(
          `UPDATE accounts SET ${entries.map(([k]) => `${k}=?`).join(",")} WHERE id=?`,
        )
        .run(...entries.map(([, v]) => v), id);
    return this.account(id);
  }
  deleteAccount(id, actor) {
    const account = this.account(id);
    if (!account) throw new Error("抖音号不存在");
    this.db.exec("SAVEPOINT delete_account");
    try {
      if (
        this.db
          .prepare(
            "SELECT id FROM jobs WHERE account_id=? AND status='running'",
          )
          .get(id)
      )
        throw new Error("该账号有正在执行的任务，请完成后再删除");
      this.audit(actor, "删除抖音号", account.anchor_id, id, {
        handle: account.handle,
        nickname: account.nickname,
      });
      this.db
        .prepare(
          "DELETE FROM notice_reads WHERE notice_id IN (SELECT id FROM notices WHERE account_id=?)",
        )
        .run(id);
      for (const table of [
        "online_sessions",
        "online_coverage",
        "notices",
        "jobs",
        "login_checks",
        "runs",
        "coverage",
        "sessions",
      ])
        this.db.prepare(`DELETE FROM ${table} WHERE account_id=?`).run(id);
      this.db.prepare("DELETE FROM accounts WHERE id=?").run(id);
      this.db.exec("RELEASE delete_account");
    } catch (e) {
      this.db.exec("ROLLBACK TO delete_account; RELEASE delete_account");
      throw e;
    }
  }
  deleteAnchor(id, actor) {
    const anchor = this.anchor(id);
    if (!anchor) throw new Error("主播不存在");
    const accounts = this.listAccounts().filter((a) => a.anchor_id === id);
    const exists = (table) =>
      Boolean(
        this.db
          .prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?")
          .get(table),
      );
    this.db.exec("BEGIN IMMEDIATE");
    try {
      if (
        this.db
          .prepare(
            "SELECT 1 FROM jobs WHERE status='running' AND (owner_anchor_id=? OR account_id IN (SELECT id FROM accounts WHERE anchor_id=?))",
          )
          .get(id, id)
      )
        throw new Error("该主播有正在执行的任务，请结束后再删除");
      const users = exists("users")
        ? this.db.prepare("SELECT id,role FROM users WHERE anchor_id=?").all(id)
        : [];
      if (users.some((u) => u.role === "admin"))
        throw new Error("不能删除管理员登录账号");
      for (const u of users) {
        if (
          this.db
            .prepare("SELECT 1 FROM jobs WHERE actor_id=? AND status='running'")
            .get(u.id)
        )
          throw new Error("该主播有正在执行的任务，请结束后再删除");
      }
      for (const a of accounts) this.deleteAccount(a.id, actor);
      for (const u of users) {
        this.db.prepare("DELETE FROM jobs WHERE actor_id=?").run(u.id);
        this.db.prepare("DELETE FROM notice_reads WHERE user_id=?").run(u.id);
        if (exists("guarantee_reads"))
          this.db
            .prepare("DELETE FROM guarantee_reads WHERE user_id=?")
            .run(u.id);
        if (exists("auth_sessions"))
          this.db
            .prepare("DELETE FROM auth_sessions WHERE user_id=?")
            .run(u.id);
        this.db.prepare("DELETE FROM users WHERE id=?").run(u.id);
      }
      this.db.prepare("DELETE FROM jobs WHERE owner_anchor_id=?").run(id);
      if (exists("guarantee_reads") && exists("guarantee_notices"))
        this.db
          .prepare(
            "DELETE FROM guarantee_reads WHERE notice_id IN (SELECT id FROM guarantee_notices WHERE anchor_id=?)",
          )
          .run(id);
      for (const table of ["guarantee_notices", "monthly_guarantees"])
        if (exists(table))
          this.db.prepare(`DELETE FROM ${table} WHERE anchor_id=?`).run(id);
      const members = this.db
        .prepare("UPDATE anchors SET leader_id=NULL WHERE leader_id=?")
        .run(id).changes;
      this.db.prepare("DELETE FROM anchors WHERE id=?").run(id);
      this.audit(actor, "删除主播", id, null, {
        name: anchor.name,
        accounts: accounts.length,
        members,
      });
      this.db.exec("COMMIT");
      return { accounts: accounts.length, members };
    } catch (e) {
      this.db.exec("ROLLBACK");
      throw e;
    }
  }
  saveDay(accountId, date, sessions, complete = true, calendar = false) {
    const temporary = this.retentionEnabled && date < retentionStart();
    const sessionTable = temporary ? "online_sessions" : "sessions";
    const coverageTable = temporary ? "online_coverage" : "coverage";
    this.db.exec("BEGIN IMMEDIATE");
    try {
      for (const s of sessions) {
        if (
          calendar
            ? s.date !== s.start.slice(0, 10) ||
              s.date > date ||
              s.end.slice(0, 10) < date
            : s.date !== date
        )
          throw new Error("场次日期不匹配，未写入");
        const recordTable =
          this.retentionEnabled && s.date < retentionStart()
            ? "online_sessions"
            : "sessions";
        const existing = this.db
          .prepare(
            "SELECT account_id,count_labels,calendar_dates FROM report_sessions WHERE room_id=?",
          )
          .get(s.roomId);
        if (existing && existing.account_id !== accountId)
          throw new Error(
            "该场次已属于另一个抖音号，请核对扫码账号；未重复计入",
          );
        const labels = { ...metricLabels(existing) };
        const calendarDates = JSON.parse(existing?.calendar_dates || "[]");
        if (calendar && !calendarDates.includes(date)) calendarDates.push(date);
        for (const key of countKeys) {
          if (s[key] == null) continue;
          delete labels[key];
          if (metricLabels(s)[key]) labels[key] = metricLabels(s)[key];
        }
        this.db
          .prepare(
            `INSERT INTO ${recordTable}(room_id,account_id,title,start,end,date,duration,followers,gifters,updated_at,fanclub,commenters,exposure,entrants,entry_rate,count_labels,calendar_dates) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(room_id) DO UPDATE SET title=excluded.title,start=excluded.start,end=excluded.end,date=excluded.date,duration=excluded.duration,followers=excluded.followers,gifters=excluded.gifters,updated_at=excluded.updated_at,fanclub=COALESCE(excluded.fanclub,${recordTable}.fanclub),commenters=COALESCE(excluded.commenters,${recordTable}.commenters),exposure=COALESCE(excluded.exposure,${recordTable}.exposure),entrants=COALESCE(excluded.entrants,${recordTable}.entrants),entry_rate=COALESCE(excluded.entry_rate,${recordTable}.entry_rate),count_labels=excluded.count_labels,calendar_dates=excluded.calendar_dates`,
          )
          .run(
            s.roomId,
            accountId,
            s.title,
            s.start,
            s.end,
            s.date,
            s.duration,
            s.followers,
            s.gifters,
            new Date().toISOString(),
            s.fanclub ?? null,
            s.commenters ?? null,
            s.exposure ?? null,
            s.entrants ?? null,
            s.entry_rate ?? null,
            JSON.stringify(labels),
            JSON.stringify(calendarDates),
          );
      }
      const count = this.db
        .prepare(
          `SELECT COUNT(*) n FROM ${sessionTable} WHERE account_id=? AND date=?`,
        )
        .get(accountId, date).n;
      const listedCount = calendar
        ? this.db
            .prepare(
              "SELECT COUNT(*) n FROM report_sessions s WHERE account_id=? AND (EXISTS (SELECT 1 FROM json_each(s.calendar_dates) WHERE value=?) OR (s.calendar_dates='[]' AND s.date=?))",
            )
            .get(accountId, date, date).n
        : count;
      if (
        complete &&
        listedCount !== new Set(sessions.map((s) => s.roomId)).size
      )
        throw new Error("本次场次列表与已保存明细不一致，保留原数据并等待复查");
      this.db
        .prepare(
          `INSERT INTO ${coverageTable}(account_id,date,checked_at,session_count,finalized) VALUES(?,?,?,?,?) ON CONFLICT(account_id,date) DO UPDATE SET checked_at=excluded.checked_at,session_count=excluded.session_count,finalized=excluded.finalized`,
        )
        .run(
          accountId,
          date,
          new Date().toISOString(),
          count,
          complete && date < chinaDate() ? 1 : 0,
        );
      // Calendar buckets can contain broadcasts that started on an earlier day.
      // Refresh that reporting day's count without claiming its calendar was scanned.
      for (const startDate of new Set(
        sessions.map((s) => s.date).filter((d) => d !== date),
      )) {
        const targetCoverage =
          this.retentionEnabled && startDate < retentionStart()
            ? "online_coverage"
            : "coverage";
        const actualCount = this.db
          .prepare(
            "SELECT COUNT(*) n FROM report_sessions WHERE account_id=? AND date=?",
          )
          .get(accountId, startDate).n;
        this.db
          .prepare(
            `INSERT INTO ${targetCoverage}(account_id,date,checked_at,session_count,finalized) VALUES(?,?,?,?,0) ON CONFLICT(account_id,date) DO UPDATE SET session_count=excluded.session_count`,
          )
          .run(accountId, startDate, new Date().toISOString(), actualCount);
        if (targetCoverage === "coverage")
          this.db
            .prepare(
              "UPDATE accounts SET tracking_from=MIN(tracking_from,?) WHERE id=?",
            )
            .run(startDate, accountId);
      }
      if (!temporary)
        this.db
          .prepare(
            "UPDATE accounts SET tracking_from=MIN(tracking_from,?) WHERE id=?",
          )
          .run(date, accountId);
      this.db.exec("COMMIT");
    } catch (e) {
      this.db.exec("ROLLBACK");
      throw e;
    }
  }
  settings() {
    return {
      realtimeEnabled: true,
      intervalMinutes: 360,
      lastRealtimeAt: null,
      ...JSON.parse(
        this.db.prepare("SELECT value FROM settings WHERE key='schedule'").get()
          .value,
      ),
    };
  }
  setSettings(patch) {
    const s = { ...this.settings(), ...patch };
    this.db
      .prepare("UPDATE settings SET value=? WHERE key='schedule'")
      .run(JSON.stringify(s));
    return s;
  }
  startRun(accountId, from, to, source) {
    const id = randomUUID();
    this.db
      .prepare(
        "INSERT INTO runs(id,account_id,source,from_date,to_date,status,started_at) VALUES(?,?,?,?,?,?,?)",
      )
      .run(
        id,
        accountId,
        source,
        from,
        to,
        "running",
        new Date().toISOString(),
      );
    return id;
  }
  endRun(id, status, message, count = 0) {
    this.db
      .prepare(
        "UPDATE runs SET status=?,message=?,session_count=?,ended_at=? WHERE id=?",
      )
      .run(status, message, count, new Date().toISOString(), id);
    const run = this.db
      .prepare("SELECT account_id FROM runs WHERE id=?")
      .get(id);
    if (run?.account_id) {
      if (status === "success") this.resolveNotice(run.account_id, "sync");
      else if (status === "error") this.notify(run.account_id, "sync", message);
    }
  }
  runs(anchorId = "", page = 1, limit = 100) {
    const scope = scopeSql("b.anchor_id", anchorId);
    return this.db
      .prepare(
        `SELECT r.*,CASE WHEN b.handle LIKE 'pending:%' THEN '' ELSE b.handle END handle,b.nickname,a.name anchor_name FROM runs r LEFT JOIN accounts b ON r.account_id=b.id LEFT JOIN anchors a ON b.anchor_id=a.id WHERE ${scope.sql} ORDER BY started_at DESC,r.id DESC LIMIT ? OFFSET ?`,
      )
      .all(...scope.params, limit, (page - 1) * limit);
  }
  runCount(anchorId = "") {
    const scope = scopeSql("b.anchor_id", anchorId);
    return this.db
      .prepare(
        `SELECT COUNT(*) n FROM runs r LEFT JOIN accounts b ON r.account_id=b.id WHERE ${scope.sql}`,
      )
      .get(...scope.params).n;
  }
  audit(actor, action, anchorId, accountId, details) {
    this.db
      .prepare(
        "INSERT INTO audit_events(actor,action,anchor_id,account_id,details,created_at) VALUES(?,?,?,?,?,?)",
      )
      .run(
        actor,
        action,
        anchorId || null,
        accountId || null,
        JSON.stringify(details),
        new Date().toISOString(),
      );
  }
  audits(page = 1) {
    return this.db
      .prepare("SELECT * FROM audit_events ORDER BY id DESC LIMIT 15 OFFSET ?")
      .all((page - 1) * 15);
  }
  notify(accountId, kind, message) {
    if (this.notificationsDisabled) return;
    const now = new Date().toISOString();
    const existing = this.db
      .prepare(
        "SELECT * FROM notices WHERE account_id IS ? AND kind=? AND resolved=0",
      )
      .get(accountId, kind);
    if (existing) {
      if (existing.message !== message)
        this.db
          .prepare("UPDATE notices SET message=?,updated_at=? WHERE id=?")
          .run(message, now, existing.id);
    } else
      this.db
        .prepare(
          "INSERT INTO notices(account_id,kind,message,created_at,updated_at) VALUES(?,?,?,?,?)",
        )
        .run(accountId, kind, message, now, now);
  }
  resolveNotice(accountId, kind) {
    this.db
      .prepare(
        "UPDATE notices SET resolved=1,updated_at=? WHERE account_id IS ? AND kind=? AND resolved=0",
      )
      .run(new Date().toISOString(), accountId, kind);
  }
  notices(user) {
    return this.db
      .prepare(
        `SELECT n.*,CASE WHEN b.handle LIKE 'pending:%' THEN '' ELSE b.handle END handle,b.nickname,a.name anchor_name,CASE WHEN nr.read_at>=n.updated_at THEN 1 ELSE 0 END is_read FROM notices n LEFT JOIN accounts b ON b.id=n.account_id LEFT JOIN anchors a ON a.id=b.anchor_id LEFT JOIN notice_reads nr ON nr.notice_id=n.id AND nr.user_id=? ${user.role === "admin" ? "" : "WHERE b.anchor_id=?"} ORDER BY n.resolved,n.updated_at DESC LIMIT 100`,
      )
      .all(user.id, ...(user.role === "admin" ? [] : [user.anchor_id]));
  }
  recover() {
    this.db
      .prepare(
        "UPDATE runs SET status='error',message='服务中断，待重新同步',ended_at=? WHERE status='running'",
      )
      .run(new Date().toISOString());
    this.db.exec(
      "UPDATE accounts SET status='ready' WHERE status='syncing'; UPDATE accounts SET status='unbound' WHERE status='binding'",
    );
    this.db.exec(
      "UPDATE jobs SET status='queued',message='服务恢复，等待重试',started_at=NULL WHERE status='running' AND kind!='login'; UPDATE jobs SET status='cancelled',message='服务重启，请重新扫码' WHERE status='running' AND kind='login'",
    );
    for (const a of this.listAccounts())
      if (a.error) this.notify(a.id, "sync", a.error);
  }
  report(month, anchorId = "", accountId = "", today = chinaDate()) {
    const { from, to } = monthRange(month);
    this.expireOnline();
    const retainedFrom = this.retentionEnabled ? retentionStart(today) : null;
    const params = [from, to];
    let filter = "";
    if (anchorId) {
      const scope = scopeSql("b.anchor_id", anchorId);
      filter += ` AND ${scope.sql}`;
      params.push(...scope.params);
    }
    if (accountId) {
      filter += " AND b.id=?";
      params.push(accountId);
    }
    const sessions = this.db
      .prepare(
        `SELECT s.*,CASE WHEN b.handle LIKE 'pending:%' THEN '' ELSE b.handle END handle,b.nickname,b.anchor_id,a.name anchor_name FROM report_sessions s JOIN accounts b ON b.id=s.account_id JOIN anchors a ON a.id=b.anchor_id WHERE date>=? AND date<=?${filter} ORDER BY start DESC`,
      )
      .all(...params);
    const accounts = this.listAccounts().filter(
      (b) =>
        inScope(b.anchor_id, anchorId) && (!accountId || b.id === accountId),
    );
    const coverage = this.db
      .prepare(
        `SELECT c.* FROM report_coverage c JOIN accounts b ON b.id=c.account_id WHERE date>=? AND date<=?${filter}`,
      )
      .all(...params);
    const sum = (rows) =>
      rows.reduce(
        (r, s) => ({
          duration: r.duration + s.duration,
          followers: r.followers + s.followers,
          gifters: r.gifters + s.gifters,
          fanclub:
            r.fanclub === null || s.fanclub == null
              ? null
              : r.fanclub + s.fanclub,
          commenters:
            r.commenters === null || s.commenters == null
              ? null
              : r.commenters + s.commenters,
          sessions: r.sessions + 1,
        }),
        {
          duration: 0,
          followers: 0,
          gifters: 0,
          fanclub: 0,
          commenters: 0,
          sessions: 0,
        },
      );
    const daily = datesBetween(from, to).map((date) => {
      const rows = sessions.filter((s) => s.date === date);
      const dayCoverage = coverage.filter((c) => c.date === date);
      const expectedAccounts = accounts.filter(
        (a) =>
          dayCoverage.some((c) => c.account_id === a.id) ||
          (a.approval === "approved" && a.enabled && a.tracking_from <= date),
      );
      const checked = dayCoverage.filter(
        (c) => c.finalized || date === today,
      ).length;
      return {
        date,
        ...sum(rows),
        ...trafficTotals(rows),
        checked,
        expected: expectedAccounts.length,
        state:
          retainedFrom && date < retainedFrom && !dayCoverage.length
            ? "online_required"
            : date > today
              ? "pending"
              : date === today
                ? "provisional"
                : !expectedAccounts.length
                  ? "empty"
                  : checked === expectedAccounts.length
                    ? "complete"
                    : checked
                      ? "partial"
                      : "missing",
      };
    });
    const anchors = this.listAnchors()
      .filter((a) => inScope(a.id, anchorId))
      .map((a) => ({
        ...a,
        ...sum(sessions.filter((s) => s.anchor_id === a.id)),
        ...trafficTotals(sessions.filter((s) => s.anchor_id === a.id)),
        accounts: accounts.filter((b) => b.anchor_id === a.id).length,
      }));
    const totals = { ...sum(sessions), ...trafficTotals(sessions) };
    const past = daily.filter((d) => d.date < today && d.expected > 0);
    const allTimeParams = [];
    let allTimeFilter = "1=1";
    if (anchorId) {
      const scope = scopeSql("b.anchor_id", anchorId);
      allTimeFilter += ` AND ${scope.sql}`;
      allTimeParams.push(...scope.params);
    }
    if (accountId) {
      allTimeFilter += " AND b.id=?";
      allTimeParams.push(accountId);
    }
    const allTime = this.db
      .prepare(
        `SELECT COALESCE(SUM(s.duration),0) duration,COALESCE(SUM(s.followers),0) followers,COALESCE(SUM(s.gifters),0) gifters,CASE WHEN COUNT(*)=COUNT(s.fanclub) THEN COALESCE(SUM(s.fanclub),0) END fanclub,CASE WHEN COUNT(*)=COUNT(s.commenters) THEN COALESCE(SUM(s.commenters),0) END commenters,COUNT(*) sessions,MIN(s.date) first_date FROM sessions s JOIN accounts b ON b.id=s.account_id WHERE ${allTimeFilter}`,
      )
      .get(...allTimeParams);
    Object.assign(
      allTime,
      trafficTotals(
        this.db
          .prepare(
            `SELECT s.followers,s.gifters,s.fanclub,s.commenters,s.exposure,s.entrants,s.count_labels FROM sessions s JOIN accounts b ON b.id=s.account_id WHERE ${allTimeFilter}`,
          )
          .all(...allTimeParams),
      ),
    );
    return {
      retention: retainedFrom
        ? {
            from: retainedFrom,
            logDays: 7,
            temporaryMinutes: 30,
            historical: to < retainedFrom,
          }
        : null,
      month,
      from,
      to,
      today,
      totals,
      allTime,
      daily,
      anchors,
      sessions,
      accounts,
      coverage,
      completeDays: past.filter((d) => d.state === "complete").length,
      elapsedDays: past.length,
      activeDays: new Set(sessions.map((s) => s.date)).size,
    };
  }
  automaticRange(accountId, today = chinaDate()) {
    const ranges = this.automaticRanges(accountId, today);
    return ranges.length
      ? { from: ranges[0].from, to: ranges.at(-1).to }
      : null;
  }
  automaticRanges(accountId, today = chinaDate(), bounds = {}) {
    const a = this.account(accountId),
      floor = this.retentionEnabled
        ? [shiftDate(today, -89), retentionStart(today)].sort().at(-1)
        : shiftDate(today, -89),
      to = bounds.to && bounds.to < today ? bounds.to : today;
    const from = [a.tracking_from, floor, bounds.from || floor].sort().at(-1);
    if (from > to) return [];
    const covered = new Set(
      this.db
        .prepare(
          "SELECT date FROM coverage c WHERE account_id=? AND date>=? AND date<=? AND finalized=1 AND NOT EXISTS (SELECT 1 FROM sessions s WHERE s.account_id=c.account_id AND s.date=c.date AND (s.fanclub IS NULL OR s.commenters IS NULL OR s.exposure IS NULL OR s.entrants IS NULL OR s.entry_rate IS NULL))",
        )
        .all(accountId, from, to)
        .map((c) => c.date),
    );
    const ranges = [];
    for (const date of datesBetween(from, to)) {
      // Today is provisional: later broadcasts and refreshed metrics must still
      // be collected. Past dates with complete metrics need no repeat visit.
      if (covered.has(date) && date < today) continue;
      const last = ranges.at(-1);
      if (last && shiftDate(last.to, 1) === date) last.to = date;
      else ranges.push({ from: date, to: date });
    }
    return ranges;
  }
  expireOnline(now = new Date()) {
    const cutoff = new Date(now.getTime() - 30 * 60000).toISOString();
    this.db
      .prepare("DELETE FROM online_sessions WHERE updated_at<?")
      .run(cutoff);
    this.db
      .prepare("DELETE FROM online_coverage WHERE checked_at<?")
      .run(cutoff);
  }
  cleanupLive(now = new Date()) {
    this.expireOnline(now);
    if (!this.retentionEnabled) return;
    const today = chinaDate(now),
      from = retentionStart(today);
    this.db.exec("BEGIN IMMEDIATE");
    try {
      this.db.prepare("DELETE FROM sessions WHERE date<?").run(from);
      this.db.prepare("DELETE FROM coverage WHERE date<?").run(from);
      this.db.exec("COMMIT");
    } catch (e) {
      this.db.exec("ROLLBACK");
      throw e;
    }
    if (
      this.db
        .prepare("SELECT value FROM settings WHERE key='last_storage_compact'")
        .get()?.value !== today
    ) {
      // Actually return free database pages to the filesystem, at most once a day.
      this.db.exec("VACUUM; PRAGMA wal_checkpoint(TRUNCATE)");
      this.db
        .prepare(
          "INSERT INTO settings(key,value) VALUES('last_storage_compact',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value",
        )
        .run(today);
    }
  }
}
