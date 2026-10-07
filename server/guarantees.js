import {
  chinaDate,
  monthRange,
  datesBetween,
  retentionStart,
} from "./domain.js";
import { scopeSql } from "./scope.js";

export class Guarantees {
  constructor(store) {
    this.store = store;
    this.db = store.db;
    this.db
      .exec(`CREATE TABLE IF NOT EXISTS monthly_guarantees(anchor_id TEXT NOT NULL REFERENCES anchors(id),month TEXT NOT NULL,seconds INTEGER NOT NULL CHECK(seconds>=0),PRIMARY KEY(anchor_id,month));
      CREATE TABLE IF NOT EXISTS guarantee_notices(id INTEGER PRIMARY KEY AUTOINCREMENT,anchor_id TEXT NOT NULL REFERENCES anchors(id),date TEXT NOT NULL,message TEXT NOT NULL,resolved INTEGER NOT NULL DEFAULT 0,created_at TEXT NOT NULL,UNIQUE(anchor_id,date));
      CREATE TABLE IF NOT EXISTS guarantee_reads(notice_id INTEGER NOT NULL,user_id TEXT NOT NULL,PRIMARY KEY(notice_id,user_id));`);
  }
  progress(month, anchorId = "") {
    const { from, to } = monthRange(month);
    const scope = scopeSql("a.id", anchorId);
    return this.db
      .prepare(
        `SELECT a.id anchor_id,a.name,g.seconds target,COALESCE(SUM(s.duration),0) actual FROM anchors a LEFT JOIN monthly_guarantees g ON g.anchor_id=a.id AND g.month=? LEFT JOIN accounts b ON b.anchor_id=a.id LEFT JOIN sessions s ON s.account_id=b.id AND s.date>=? AND s.date<=? WHERE ${scope.sql} GROUP BY a.id ORDER BY a.created_at`,
      )
      .all(month, from, to, ...scope.params)
      .map((r) => ({
        ...r,
        remaining: r.target == null ? null : Math.max(0, r.target - r.actual),
        excess: r.target == null ? null : Math.max(0, r.actual - r.target),
        status:
          r.target == null
            ? "unset"
            : r.actual < r.target
              ? "below"
              : r.actual === r.target
                ? "met"
                : "exceeded",
        ...(this.store.retentionEnabled && month < retentionStart().slice(0, 7)
          ? {
              actual: null,
              remaining: null,
              excess: null,
              status: "unavailable",
            }
          : {}),
      }));
  }
  set(anchorId, month, seconds, actor) {
    monthRange(month);
    if (!this.store.anchor(anchorId)) throw Error("主播不存在");
    if (!Number.isSafeInteger(seconds) || seconds < 0 || seconds > 10000 * 3600)
      throw Error("保底时长不正确");
    this.db
      .prepare(
        "INSERT INTO monthly_guarantees VALUES(?,?,?) ON CONFLICT(anchor_id,month) DO UPDATE SET seconds=excluded.seconds",
      )
      .run(anchorId, month, seconds);
    this.store.audit(actor, "设置月度保底", anchorId, null, {
      月份: month,
      保底小时: seconds / 3600,
    });
    this.remind();
  }
  remind(now = new Date()) {
    const today = chinaDate(now),
      month = today.slice(0, 7),
      { to } = monthRange(month);
    this.db
      .prepare(
        "UPDATE guarantee_notices SET resolved=1 WHERE substr(date,1,7)<>?",
      )
      .run(month);
    for (const p of this.progress(month)) {
      if (p.status !== "below") {
        this.db
          .prepare(
            "UPDATE guarantee_notices SET resolved=1 WHERE anchor_id=? AND substr(date,1,7)=?",
          )
          .run(p.anchor_id, month);
        continue;
      }
      if (datesBetween(today, to).length > 7) continue;
      const minutes = Math.ceil(p.remaining / 60);
      const message = `${p.name}：${month} 直播保底尚未达标，还差 ${Math.floor(minutes / 60)} 小时 ${minutes % 60} 分钟（按已采集数据）。`;
      this.db
        .prepare(
          "INSERT OR IGNORE INTO guarantee_notices(anchor_id,date,message,created_at) VALUES(?,?,?,?)",
        )
        .run(p.anchor_id, today, message, now.toISOString());
    }
  }
  notices(user) {
    const scope = scopeSql("n.anchor_id", this.store.readScope(user));
    return this.db
      .prepare(
        `SELECT n.*,a.name anchor_name,n.created_at updated_at,CASE WHEN r.user_id IS NULL THEN 0 ELSE 1 END is_read FROM guarantee_notices n JOIN anchors a ON a.id=n.anchor_id LEFT JOIN guarantee_reads r ON r.notice_id=n.id AND r.user_id=? WHERE ${scope.sql} ORDER BY n.date DESC,n.id DESC`,
      )
      .all(user.id, ...scope.params);
  }
  read(id, user) {
    if (!this.notices(user).some((n) => n.id === id)) throw Error("通知不存在");
    this.db
      .prepare("INSERT OR IGNORE INTO guarantee_reads VALUES(?,?)")
      .run(id, user.id);
  }
  cleanup(now = new Date()) {
    const cutoff = new Date(now.getTime() - 7 * 86400000).toISOString();
    this.db.exec("BEGIN IMMEDIATE");
    try {
      this.db
        .prepare(
          "DELETE FROM runs WHERE status!='running' AND COALESCE(ended_at,started_at)<?",
        )
        .run(cutoff);
      this.db
        .prepare(
          "DELETE FROM jobs WHERE status NOT IN ('queued','running') AND COALESCE(ended_at,created_at)<?",
        )
        .run(cutoff);
      this.db
        .prepare("DELETE FROM login_checks WHERE checked_at<?")
        .run(cutoff);
      this.db
        .prepare("DELETE FROM audit_events WHERE created_at<?")
        .run(cutoff);
      this.db.exec("DELETE FROM notice_reads; DELETE FROM notices;");
      this.db
        .prepare(
          "DELETE FROM guarantee_reads WHERE notice_id IN (SELECT id FROM guarantee_notices WHERE created_at<?)",
        )
        .run(cutoff);
      this.db
        .prepare("DELETE FROM guarantee_notices WHERE created_at<?")
        .run(cutoff);
      this.db.exec("COMMIT");
    } catch (e) {
      this.db.exec("ROLLBACK");
      throw e;
    }
  }
}
