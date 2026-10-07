import { randomUUID } from "node:crypto";
import { validateCollectionRange } from "./domain.js";

export class Jobs {
  constructor(store, collector) {
    this.store = store;
    this.collector = collector;
    this.activeTasks = new Map();
    this.closed = false;
    this.timer = setInterval(() => this.tick(), 1000);
    this.timer.unref();
  }
  list(user, page = 1, active = false) {
    return this.store.db
      .prepare(
        `SELECT j.id,j.account_id,j.kind,j.status,j.message,j.created_at,j.started_at,j.ended_at,CASE WHEN b.handle LIKE 'pending:%' THEN '' ELSE b.handle END handle,b.nickname FROM jobs j JOIN accounts b ON b.id=j.account_id WHERE 1=1 ${user.role === "admin" ? "" : "AND b.anchor_id=?"} ${active ? "AND j.status IN ('queued','running')" : ""} ORDER BY CASE WHEN j.status='running' THEN 0 WHEN j.status='queued' THEN 1 ELSE 2 END,j.created_at DESC LIMIT 15 OFFSET ?`,
      )
      .all(...(user.role === "admin" ? [] : [user.anchor_id]), (page - 1) * 15);
  }
  get running() {
    return this.activeTasks.size > 0;
  }
  count(user) {
    return this.store.db
      .prepare(
        `SELECT COUNT(*) n FROM jobs j JOIN accounts b ON b.id=j.account_id WHERE j.status IN ('queued','running') ${user.role === "admin" ? "" : "AND b.anchor_id=?"}`,
      )
      .get(...(user.role === "admin" ? [] : [user.anchor_id])).n;
  }
  enqueue(kind, account, user, payload = {}) {
    if (!["sync", "check", "login"].includes(kind))
      throw new Error("任务类型不正确");
    if (
      kind === "sync" &&
      (!account.enabled ||
        account.approval !== "approved" ||
        ["unbound", "binding", "expired", "verification", "mismatch"].includes(
          account.status,
        ))
    )
      throw new Error("该账号尚不可同步，请核对启用和登录状态");
    if (payload.from || payload.to) {
      validateCollectionRange(payload.from, payload.to);
    }
    const clean =
      kind === "sync"
        ? {
            from: payload.from || null,
            to: payload.to || null,
            source: user
              ? "manual"
              : payload.source === "realtime"
                ? "realtime"
                : "scheduled",
          }
        : {};
    const dedupe = JSON.stringify([kind, account.id, clean.from, clean.to]);
    const existing = this.store.db
      .prepare(
        "SELECT id,status FROM jobs WHERE dedupe=? AND status IN ('queued','running')",
      )
      .get(dedupe);
    if (existing) return { ...existing, duplicate: true };
    const id = randomUUID();
    this.store.db
      .prepare(
        "INSERT INTO jobs(id,account_id,actor_id,owner_anchor_id,kind,payload,dedupe,status,created_at) VALUES(?,?,?,?,?,?,?,'queued',?)",
      )
      .run(
        id,
        account.id,
        user?.id || null,
        user?.role === "anchor" ? user.anchor_id : null,
        kind,
        JSON.stringify(clean),
        dedupe,
        new Date().toISOString(),
      );
    return { id, status: "queued", duplicate: false };
  }
  async tick() {
    if (this.closed) return;
    const c = this.collector;
    if (c.exporting) return;
    const occupied = new Set([
      ...c.bindings.keys(),
      ...[...this.activeTasks.values()].map((t) => t.accountId),
      ...(c.syncAccountId ? [c.syncAccountId] : []),
      ...(c.checking ? [c.checking] : []),
    ]);
    if (occupied.size >= (c.maxBrowsers || 2)) return;
    const nonLoginActive =
      [...this.activeTasks.values()].some((t) => t.kind !== "login") ||
      c.busy ||
      c.checking;
    const job = this.store.db
      .prepare(
        "SELECT * FROM jobs WHERE status='queued' AND available_at<=? ORDER BY CASE kind WHEN 'login' THEN 0 WHEN 'check' THEN 1 ELSE 2 END,created_at,id",
      )
      .all(Date.now())
      .find(
        (j) =>
          !occupied.has(j.account_id) &&
          (j.kind === "login"
            ? !(c.busy && !c.syncAccountId)
            : !nonLoginActive),
      );
    if (!job) return;
    const active = { accountId: job.account_id, kind: job.kind };
    this.activeTasks.set(job.id, active);
    this.task = active.task = this.execute(job)
      .catch(() => {})
      .finally(() => {
        this.activeTasks.delete(job.id);
      });
    return this.task;
  }
  async execute(job) {
    const db = this.store.db,
      c = this.collector;
    try {
      const a = this.store.account(job.account_id);
      const actor =
        job.actor_id &&
        db.prepare("SELECT * FROM users WHERE id=?").get(job.actor_id);
      if (
        job.actor_id &&
        (!actor?.enabled ||
          (actor.role !== "admin" && a.anchor_id !== actor.anchor_id))
      )
        throw new Error("账号归属或登录权限已变化，任务已取消");
      if (a.approval === "rejected" && actor?.role !== "admin")
        throw new Error("绑定申请已拒绝");
      db.prepare(
        "UPDATE jobs SET status='running',started_at=?,attempts=attempts+1,message='处理中' WHERE id=?",
      ).run(new Date().toISOString(), job.id);
      let message = "已完成";
      if (job.kind === "sync") {
        const payload = JSON.parse(job.payload);
        const beforeRun = db
          .prepare(
            "SELECT id FROM runs WHERE account_id=? ORDER BY started_at DESC LIMIT 1",
          )
          .get(a.id)?.id;
        c.startSync({
          accountId: a.id,
          anchorId: job.owner_anchor_id || undefined,
          ...payload,
        });
        await c.task;
        const latest = db
          .prepare(
            "SELECT id,status,message FROM runs WHERE account_id=? ORDER BY started_at DESC LIMIT 1",
          )
          .get(a.id);
        if (c.stopping) throw new Error("同步已停止");
        if (latest?.status === "error" && latest.id !== beforeRun)
          throw new Error(latest.message);
        message =
          latest?.id !== beforeRun
            ? latest?.message || "已完成"
            : "没有需要采集的日期";
      } else if (job.kind === "check") {
        const result = await c.startLoginCheck(a.id);
        message = result.message;
        if (result.result !== "valid") throw new Error(message);
      } else {
        await c.startBinding(a.id);
        while (c.bindings.has(a.id) && !this.closed)
          await new Promise((r) => setTimeout(r, 500));
        if (this.closed) return;
        if (this.store.account(a.id).status !== "ready")
          throw new Error(
            this.store.account(a.id).error || "登录已取消或未完成",
          );
        const bound = this.store.account(a.id);
        if (bound.enabled && bound.approval === "approved") {
          this.enqueue("sync", bound, actor || null, { source: "realtime" });
          message = "登录完成，已加入当月同步队列";
        } else {
          message = "登录完成，账号已暂停，未启动同步";
        }
      }
      db.prepare(
        "UPDATE jobs SET status='success',message=?,ended_at=? WHERE id=? AND status='running'",
      ).run(message, new Date().toISOString(), job.id);
      this.store.resolveNotice(a.id, "task");
    } catch (e) {
      const current = db
        .prepare("SELECT status,attempts FROM jobs WHERE id=?")
        .get(job.id);
      if (current?.status === "cancelled") return;
      if (
        !this.closed &&
        current?.status === "running" &&
        job.kind === "sync" &&
        current.attempts < 3 &&
        this.store.account(job.account_id).status === "error" &&
        /超时|网络|加载|数据请求未完成|无法读取抖音统计结果|日期筛选响应不匹配|日期筛选结果不匹配|场次切换尚未完成/.test(
          e.message,
        )
      ) {
        const delay = current.attempts === 1 ? 60000 : 300000;
        db.prepare(
          "UPDATE jobs SET status='queued',message=?,available_at=? WHERE id=?",
        ).run(
          `暂时失败，${delay / 1000}秒后重试（${current.attempts}/3）：${e.message.slice(0, 120)}`,
          Date.now() + delay,
          job.id,
        );
        this.store.notify(
          job.account_id,
          "task",
          "同步暂时失败，已安排自动重试",
        );
        return;
      }
      db.prepare(
        "UPDATE jobs SET status='error',message=?,ended_at=? WHERE id=? AND status IN ('running','queued')",
      ).run(e.message.slice(0, 220), new Date().toISOString(), job.id);
      this.store.notify(job.account_id, "task", e.message.slice(0, 220));
    }
  }
  async cancel(id, user) {
    const job = this.store.db
      .prepare(
        "SELECT j.*,b.anchor_id FROM jobs j JOIN accounts b ON b.id=j.account_id WHERE j.id=?",
      )
      .get(id);
    if (!job || (user.role !== "admin" && job.anchor_id !== user.anchor_id))
      throw new Error("任务不存在或无权访问");
    if (job.status === "queued")
      this.store.db
        .prepare(
          "UPDATE jobs SET status='cancelled',message='已取消',ended_at=? WHERE id=?",
        )
        .run(new Date().toISOString(), id);
    else if (job.status === "running" && job.kind === "login") {
      this.store.db
        .prepare(
          "UPDATE jobs SET status='cancelled',message='登录已取消',ended_at=? WHERE id=?",
        )
        .run(new Date().toISOString(), id);
      await this.collector.cancelBinding(job.account_id);
    } else throw new Error("该任务已开始或已结束，无法取消");
  }
  loginStatus(accountId) {
    if (this.collector.bindings.has(accountId))
      return this.collector.bindingStatus(accountId);
    const job = this.store.db
      .prepare(
        "SELECT status,message FROM jobs WHERE account_id=? AND kind='login' AND status IN ('queued','running') ORDER BY created_at DESC LIMIT 1",
      )
      .get(accountId);
    if (job?.status === "queued") {
      const active = this.store.db
        .prepare(
          "SELECT kind FROM jobs WHERE status='running' ORDER BY started_at LIMIT 1",
        )
        .get();
      return {
        phase: "queued",
        canShow: false,
        message:
          this.collector.bindings.size +
            Number(Boolean(this.collector.busy)) +
            Number(Boolean(this.collector.checking)) >=
          (this.collector.maxBrowsers || 2)
            ? "当前两个浏览器任务正在使用中，空出位置后优先显示二维码"
            : active?.kind === "sync" || this.collector.busy
              ? "当前同步与扫码分别使用独立环境；同一账号需等待当前同步完成"
              : active?.kind === "check" || this.collector.checking
                ? "正在检测登录状态，完成后优先显示二维码"
                : "扫码任务已优先排队，即将打开登录页",
      };
    }
    // A follow-up sync may already have changed account.status to syncing/error.
    // Report this login job's outcome so the completed QR dialog still closes.
    const finished = this.store.db
      .prepare(
        "SELECT status,message FROM jobs WHERE account_id=? AND kind='login' ORDER BY created_at DESC,rowid DESC LIMIT 1",
      )
      .get(accountId);
    if (!job && finished?.status === "success")
      return { phase: "ready", message: finished.message, canShow: false };
    return this.collector.bindingStatus(accountId);
  }
  async close() {
    this.closed = true;
    clearInterval(this.timer);
    await this.collector.close();
    await Promise.allSettled([...this.activeTasks.values()].map((t) => t.task));
  }
}
