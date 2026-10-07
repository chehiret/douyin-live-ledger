import { metricLabels } from "../shared/metrics.js";
import express from "express";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { existsSync, rmSync, lstatSync, renameSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { Store } from "./store.js";
import { Collector } from "./collector.js";
import { Auth } from "./auth.js";
import { Jobs } from "./jobs.js";
import { Backups } from "./backups.js";
import { Guarantees } from "./guarantees.js";
import { inScope } from "./scope.js";
import {
  chinaDate,
  csvCell,
  scheduleDue,
  realtimeDue,
  datesBetween,
  shiftDate,
  validateCollectionRange,
  retentionStart,
} from "./domain.js";
import { cleanupFiles, installRuntimeLog } from "./retention.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const dataDir = path.resolve(
  process.env.LIVE_DATA_DIR || path.join(root, "data"),
);
export const store = new Store(path.join(dataDir, "live.sqlite"));
store.retentionEnabled = true;
installRuntimeLog(dataDir);
store.recover();
const collector = new Collector(store, dataDir);
const auth = new Auth(store, dataDir);
const jobs = new Jobs(store, collector);
const backups = new Backups(store, dataDir);
const guarantees = new Guarantees(store);
store.notificationsDisabled = true;
guarantees.cleanup();
store.cleanupLive();
cleanupFiles(dataDir);
guarantees.remind();
const app = express();
if (process.env.LIVE_TRUST_PROXY === "1") app.set("trust proxy", "loopback");
const configuredOrigin = process.env.LIVE_ORIGIN
  ? new URL(process.env.LIVE_ORIGIN).origin
  : null;
app.disable("x-powered-by");
app.use((req, res, next) => {
  const host = req.hostname;
  if (
    ![
      "127.0.0.1",
      "localhost",
      "::1",
      "[::1]",
      ...(configuredOrigin ? [new URL(configuredOrigin).hostname] : []),
    ].includes(host)
  )
    return res.status(403).json({ error: "仅允许本机访问" });
  const origin = req.get("origin");
  if (
    origin &&
    origin !== (configuredOrigin || `${req.protocol}://${req.get("host")}`)
  )
    return res.status(403).json({ error: "拒绝跨站请求" });
  if (req.get("sec-fetch-site") === "cross-site")
    return res.status(403).json({ error: "拒绝跨站请求" });
  res.set("X-Content-Type-Options", "nosniff");
  res.set("Referrer-Policy", "no-referrer");
  res.set("X-Frame-Options", "DENY");
  if (req.path.startsWith("/api")) res.set("Cache-Control", "no-store");
  next();
});
app.use(express.json({ limit: "32kb" }));
app.get("/api/health", (req, res) =>
  res.json({ app: "live-ledger", version: "1.0.0" }),
);
const route = (fn) => (req, res, next) =>
  Promise.resolve()
    .then(() => fn(req, res))
    .catch(next);
const pageNumber = (v) => {
  const n = Number(v || 1);
  if (!Number.isInteger(n) || n < 1 || n > 100000)
    throw new Error("页码不正确");
  return n;
};
const actorName = (req) => req.user.username;
app.get("/api/auth/me", (req, res) => res.json({ user: auth.user(req) }));
app.post(
  "/api/auth/login",
  route((req, res) => auth.login(req, res)),
);
app.post("/api/auth/logout", (req, res) => {
  auth.logout(req, res);
  res.json({ ok: true });
});
const adminOnly = (req, res, next) =>
  req.user.role === "admin"
    ? next()
    : res.status(403).json({ error: "仅管理员可操作" });
app.use("/api", (req, res, next) => {
  req.user = auth.user(req);
  if (!req.user) return res.status(401).json({ error: "请先登录" });
  req.readScope = store.readScope(req.user);
  req.user.is_leader = Boolean(
    req.user.role !== "admin" && store.anchor(req.user.anchor_id)?.is_leader,
  );
  next();
});
app.post(
  "/api/auth/password",
  route((req, res) => {
    auth.changePassword(req.user, req.body);
    auth.logout(req, res);
    res.json({ ok: true });
  }),
);
app.get("/api/users", adminOnly, (req, res) => res.json(auth.list()));
app.post(
  "/api/users",
  adminOnly,
  route((req, res) => {
    const u = auth.save(req.body);
    store.audit(actorName(req), "开通登录账号", u.anchor_id, null, {
      username: u.username,
    });
    res.status(201).json(u);
  }),
);
app.patch(
  "/api/users/:id",
  adminOnly,
  route((req, res) => {
    const u = auth.save(req.body, req.params.id);
    store.audit(actorName(req), "修改登录账号", u.anchor_id, null, {
      username: u.username,
      enabled: u.enabled,
      passwordReset: Boolean(req.body.password),
    });
    res.json(u);
  }),
);
app.use("/api/anchors", adminOnly);
app.use("/api/schedule", adminOnly);
app.use("/api/sync/stop", adminOnly);
// Apply ownership before every account route, including QR and login actions.
app.use("/api/accounts/:id", (req, res, next) => {
  const a = store.account(req.params.id);
  if (!a || (req.user.role !== "admin" && a.anchor_id !== req.user.anchor_id))
    return res.status(404).json({ error: "账号不存在或无权访问" });
  if (
    req.user.role !== "admin" &&
    a.approval === "rejected" &&
    req.method !== "GET"
  )
    return res.status(403).json({ error: "绑定申请已拒绝，请联系管理员" });
  next();
});
app.use(["/api/report", "/api/export"], (req, res, next) => {
  if (
    (req.query.anchorId && typeof req.query.anchorId !== "string") ||
    (req.query.accountId && typeof req.query.accountId !== "string")
  )
    return res.status(400).json({ error: "筛选参数不正确" });
  if (req.query.anchorId && !inScope(req.query.anchorId, req.readScope))
    return res.status(403).json({ error: "无权访问其他主播" });
  if (
    req.query.accountId &&
    (!store.account(req.query.accountId) ||
      !inScope(store.account(req.query.accountId).anchor_id, req.readScope))
  )
    return res.status(403).json({ error: "无权访问该抖音号" });
  req.reportScope = req.query.anchorId || req.readScope;
  next();
});
app.get(
  "/api/runs",
  route((req, res) => {
    const scope = req.readScope;
    const page = pageNumber(req.query.page);
    res.json({
      items: store.runs(scope, page, 15),
      total: store.runCount(scope),
      page,
      pageSize: 15,
    });
  }),
);
app.get(
  "/api/audits",
  adminOnly,
  route((req, res) =>
    res.json({
      items: store.audits(pageNumber(req.query.page)),
      total: store.db.prepare("SELECT COUNT(*) n FROM audit_events").get().n,
    }),
  ),
);
app.get(
  "/api/notices",
  route((req, res) => res.json(guarantees.notices(req.user))),
);
app.post(
  "/api/notices/:id/read",
  route((req, res) => {
    guarantees.read(Number(req.params.id), req.user);
    res.json({ ok: true });
  }),
);
app.get(
  "/api/jobs",
  route((req, res) =>
    res.json({
      items: jobs.list(req.user, pageNumber(req.query.page), true),
      total: jobs.count(req.user),
    }),
  ),
);
app.delete(
  "/api/jobs/:id",
  route(async (req, res) => {
    await jobs.cancel(req.params.id, req.user);
    res.json({ ok: true });
  }),
);
app.get(
  "/api/backups",
  adminOnly,
  route((req, res) => res.json(backups.list())),
);
app.post(
  "/api/backups",
  adminOnly,
  route((req, res) => {
    const b = backups.create();
    store.audit(actorName(req), "创建备份", null, null, { name: b.name });
    res.json(b);
  }),
);
app.delete(
  "/api/backups/:name",
  adminOnly,
  route((req, res) => {
    const result = backups.delete(req.params.name);
    store.audit(actorName(req), "删除备份", null, null, {
      name: req.params.name,
    });
    res.json(result);
  }),
);
app.post(
  "/api/backups/:name/verify",
  adminOnly,
  route((req, res) => res.json(backups.verify(req.params.name))),
);
app.get(
  "/api/backups/:name/download",
  adminOnly,
  route((req, res) => res.download(backups.file(req.params.name))),
);
app.get(
  "/api/backups/:name/manifest",
  adminOnly,
  route((req, res) => res.download(backups.file(req.params.name) + ".json")),
);
const text = (v, label, max = 120) => {
  if (typeof v !== "string" || !v.trim() || v.trim().length > max)
    throw new Error(`${label}不能为空且最多${max}字`);
  return v.trim();
};
const note = (v) => {
  if (v === undefined) return "";
  if (typeof v !== "string" || v.length > 1000)
    throw new Error("备注最多1000字");
  return v.trim();
};
app.get(
  "/api/accounts/:id/verification/frame",
  route(async (req, res) =>
    res.json(await collector.verificationFrame(req.params.id)),
  ),
);
const account = (id) => {
  const a = store.account(id);
  if (!a) throw new Error("账号不存在");
  return a;
};
app.post(
  "/api/accounts/:id/login/show",
  route(async (req, res) => {
    account(req.params.id);
    res.json(await collector.showBinding(req.params.id));
  }),
);
app.get(
  "/api/accounts/:id/verification/image",
  route(async (req, res) =>
    res.type("jpeg").send(await collector.verificationImage(req.params.id)),
  ),
);
app.post(
  "/api/accounts/:id/verification/input",
  route(async (req, res) =>
    res.json(await collector.verificationInput(req.params.id, req.body)),
  ),
);
app.get(
  "/api/state",
  route((req, res) => {
    const admin = req.user.role === "admin";
    const accounts = store
      .listAccounts()
      .filter((a) => inScope(a.anchor_id, req.readScope));
    const ids = new Set(
      accounts
        .filter((a) => admin || a.anchor_id === req.user.anchor_id)
        .map((a) => a.id),
    );
    const progress = collector.progress;
    res.json({
      user: req.user,
      users: admin ? auth.list() : [],
      notices: guarantees.notices(req.user),
      jobs: jobs.list(req.user, 1, true),
      anchors: store.listAnchors().filter((a) => inScope(a.id, req.readScope)),
      accounts,
      schedule: store.settings(),
      runs: store.runs(req.readScope, 1, 15),
      sync: {
        busy: collector.busy,
        progress: admin || ids.has(progress?.accountId) ? progress : null,
      },
      checking:
        admin || ids.has(collector.checking) ? collector.checking : null,
      binding: collector.bindings.size > 0,
      browserLimit: collector.maxBrowsers,
      today: chinaDate(),
    });
  }),
);
app.get(
  "/api/report",
  route((req, res) => {
    const month = req.query.month || chinaDate().slice(0, 7);
    res.json({
      ...store.report(month, req.reportScope, req.query.accountId),
      guarantees:
        month < retentionStart().slice(0, 7)
          ? []
          : guarantees.progress(month, req.reportScope),
    });
  }),
);
app.get(
  "/api/guarantees",
  route((req, res) => {
    const month = req.query.month || chinaDate().slice(0, 7);
    const result = guarantees.progress(month, req.readScope);
    res.json(result);
  }),
);
app.put(
  "/api/anchors/:id/team",
  adminOnly,
  route((req, res) =>
    res.json(store.setTeam(req.params.id, req.body, actorName(req))),
  ),
);
app.put(
  "/api/anchors/:id/guarantee",
  adminOnly,
  route((req, res) => {
    guarantees.set(
      req.params.id,
      req.body.month,
      req.body.seconds,
      actorName(req),
    );
    res.json({ ok: true });
  }),
);
app.post(
  "/api/anchors",
  route((req, res) =>
    res.status(201).json(
      store.saveAnchor({
        name: text(req.body.name, "主播名称", 60),
        note: note(req.body.note),
      }),
    ),
  ),
);
app.patch(
  "/api/anchors/:id",
  route((req, res) => {
    if (!store.anchor(req.params.id)) throw new Error("主播不存在");
    res.json(
      store.saveAnchor(
        {
          name: text(req.body.name, "主播名称", 60),
          note: note(req.body.note),
        },
        req.params.id,
      ),
    );
  }),
);
app.delete(
  "/api/anchors/:id",
  route((req, res) => {
    const anchor = store.anchor(req.params.id);
    if (!anchor) throw new Error("主播不存在");
    if (req.body.confirmation !== "确认删除")
      throw new Error("请输入“确认删除”后再删除主播");
    const anchorAccounts = store
      .listAccounts()
      .filter((a) => a.anchor_id === anchor.id);
    const accountIds = new Set(anchorAccounts.map((a) => a.id));
    if (
      (accountIds.size > 0 &&
        collector.busy &&
        (!collector.syncAccountId ||
          accountIds.has(collector.syncAccountId))) ||
      accountIds.has(collector.checking) ||
      accountIds.has(collector.exporting) ||
      [...collector.bindings.keys()].some((id) => accountIds.has(id)) ||
      [...jobs.activeTasks.values()].some((task) =>
        accountIds.has(task.accountId),
      ) ||
      store.db
        .prepare(
          "SELECT 1 FROM jobs WHERE status='running' AND (owner_anchor_id=? OR account_id IN (SELECT id FROM accounts WHERE anchor_id=?) OR actor_id IN (SELECT id FROM users WHERE anchor_id=?))",
        )
        .get(anchor.id, anchor.id, anchor.id)
    )
      throw new Error(
        "该主播名下账号正在扫码、检测或采集，请结束后再删除；其他主播的任务不影响删除",
      );
    const profiles = path.resolve(dataDir, "profiles");
    if (existsSync(profiles) && lstatSync(profiles).isSymbolicLink())
      throw new Error("登录环境根路径不可删除");
    const paths = anchorAccounts.map((a) => {
      const original = path.resolve(profiles, a.id);
      if (
        path.dirname(original) !== profiles ||
        !/^[a-f0-9-]{36}$/.test(a.id) ||
        (existsSync(original) && lstatSync(original).isSymbolicLink())
      )
        throw new Error("登录环境路径不可删除");
      return { original, temporary: original + ".deleting-" + randomUUID() };
    });
    const backup = backups.create(),
      moved = [];
    let result;
    try {
      for (const p of paths)
        if (existsSync(p.original)) {
          renameSync(p.original, p.temporary);
          moved.push(p);
        }
      result = store.deleteAnchor(anchor.id, actorName(req));
    } catch (e) {
      for (const p of moved.reverse()) renameSync(p.temporary, p.original);
      throw e;
    }
    let cleanupPending = false;
    for (const p of moved) {
      try {
        rmSync(p.temporary, { recursive: true, force: true });
      } catch {
        cleanupPending = true;
        console.error(
          "删除主播后登录环境清理失败，请清理隔离目录：",
          p.temporary,
        );
      }
    }
    res.json({ ok: true, backup: backup.name, cleanupPending, ...result });
  }),
);
app.post(
  "/api/accounts",
  route((req, res) => {
    if (req.user.role !== "admin") req.body.anchorId = req.user.anchor_id;
    if (!store.anchor(req.body.anchorId)) throw new Error("请选择所属主播");
    const created = store.createAccount({
      anchorId: req.body.anchorId,
      handle: req.body.handle
        ? text(req.body.handle, "抖音号", 100)
        : undefined,
      note: note(req.body.note),
    });
    store.audit(actorName(req), "添加抖音号", created.anchor_id, created.id, {
      handle: created.handle,
      approval: "approved",
    });
    res.status(201).json(store.account(created.id));
  }),
);
app.post(
  "/api/accounts/:id/cookies/export",
  adminOnly,
  route(async (req, res) => {
    const a = account(req.params.id);
    if (jobs.running)
      throw new Error("后台任务正在执行，请结束后再导出 Cookie");
    const cookies = await collector.exportCookies(a.id);
    store.audit(actorName(req), "导出抖音 Cookie", a.anchor_id, a.id, {
      count: cookies.length,
      format: "Cookie-Editor JSON",
    });
    res
      .attachment(`douyin-cookies-${a.douyin_handle || a.id}.json`)
      .type("application/json")
      .send(JSON.stringify(cookies, null, 2) + "\n");
  }),
);
app.delete(
  "/api/accounts/:id",
  // Ownership middleware above permits administrators or this account's owner.
  route((req, res) => {
    const a = account(req.params.id);
    if (req.body.confirmation !== "确认删除")
      throw new Error("请输入“确认删除”后再删除");
    if (
      (collector.busy &&
        (!collector.syncAccountId || collector.syncAccountId === a.id)) ||
      collector.checking === a.id ||
      collector.exporting === a.id ||
      collector.bindings.has(a.id) ||
      store.db
        .prepare("SELECT id FROM jobs WHERE account_id=? AND status='running'")
        .get(a.id)
    )
      throw new Error("该账号正在扫码、检测或采集，请结束后再删除");
    const profiles = path.resolve(dataDir, "profiles");
    const profile = path.resolve(profiles, a.id);
    if (path.dirname(profile) !== profiles || !/^[a-f0-9-]{36}$/.test(a.id))
      throw new Error("登录环境路径不正确");
    if (existsSync(profiles) && lstatSync(profiles).isSymbolicLink())
      throw new Error("登录环境根路径不可删除");
    if (existsSync(profile) && lstatSync(profile).isSymbolicLink())
      throw new Error("登录环境路径不可删除");
    const backup = backups.create();
    rmSync(profile, { recursive: true, force: true });
    store.deleteAccount(a.id, actorName(req));
    res.json({ ok: true, backup: backup.name });
  }),
);
app.patch(
  "/api/accounts/:id",
  route((req, res) => {
    const a = account(req.params.id);
    if (req.user.role !== "admin") {
      if (req.body.anchorId && req.body.anchorId !== req.user.anchor_id)
        throw new Error("无权修改账号归属");
      req.body.anchorId = req.user.anchor_id;
    }
    if (
      collector.busy ||
      collector.checking ||
      collector.exporting === a.id ||
      collector.bindings.has(a.id)
    )
      throw new Error("任务进行中，暂时不能修改归属");
    if (!store.anchor(req.body.anchorId)) throw new Error("请选择所属主播");
    if (typeof req.body.enabled !== "boolean")
      throw new Error("账号状态不正确");
    if (
      req.body.trackingFrom &&
      (!/^\d{4}-\d{2}-\d{2}$/.test(req.body.trackingFrom) ||
        req.body.trackingFrom > chinaDate())
    )
      throw new Error("统计起始日期不正确");
    if (req.body.trackingFrom)
      datesBetween(req.body.trackingFrom, req.body.trackingFrom);
    store.audit(actorName(req), "修改抖音号", a.anchor_id, a.id, {
      fromAnchor: a.anchor_id,
      toAnchor: req.body.anchorId,
      enabled: req.body.enabled,
      trackingFrom:
        req.user.role === "admin"
          ? req.body.trackingFrom || a.tracking_from
          : a.tracking_from,
    });
    res.json(
      store.updateAccount(a.id, {
        anchor_id: req.body.anchorId,
        note: note(req.body.note),
        enabled: req.body.enabled ? 1 : 0,
        tracking_from:
          req.user.role === "admin"
            ? req.body.trackingFrom || a.tracking_from
            : a.tracking_from,
      }),
    );
  }),
);
// Legacy clients cannot put accounts back into an approval workflow.
app.post("/api/accounts/:id/approval", adminOnly, (req, res) =>
  res.status(410).json({ error: "已取消绑定审核，扫码登录成功后即可使用" }),
);
app.post(
  "/api/accounts/:id/login/check",
  route(async (req, res) => {
    account(req.params.id);
    res
      .status(202)
      .json(jobs.enqueue("check", account(req.params.id), req.user));
  }),
);
app.post(
  "/api/accounts/:id/login",
  route(async (req, res) => {
    account(req.params.id);
    jobs.enqueue("login", account(req.params.id), req.user);
    res.json(jobs.loginStatus(req.params.id));
  }),
);
app.get(
  "/api/accounts/:id/login",
  route((req, res) => {
    account(req.params.id);
    res.json(jobs.loginStatus(req.params.id));
  }),
);
app.get(
  "/api/accounts/:id/qr",
  route(async (req, res) => {
    account(req.params.id);
    const png = await collector.bindingImage(req.params.id);
    if (!png) return res.status(404).end();
    res.type("png").send(png);
  }),
);
app.post(
  "/api/accounts/:id/login/refresh",
  route(async (req, res) =>
    res.json(await collector.refreshBinding(req.params.id)),
  ),
);
app.delete(
  "/api/accounts/:id/login",
  route(async (req, res) => {
    const queued = store.db
      .prepare(
        "SELECT id FROM jobs WHERE account_id=? AND kind='login' AND status IN ('queued','running')",
      )
      .all(req.params.id);
    for (const job of queued) await jobs.cancel(job.id, req.user);
    await collector.cancelBinding(req.params.id);
    res.json({ ok: true });
  }),
);
app.post(
  "/api/sync",
  route((req, res) => {
    const admin = req.user.role === "admin";
    if (
      !admin &&
      req.body.accountId &&
      store.account(req.body.accountId)?.anchor_id !== req.user.anchor_id
    )
      return res.status(403).json({ error: "无权同步该账号" });
    const accounts = store
      .listAccounts()
      .filter(
        (a) =>
          (admin || a.anchor_id === req.user.anchor_id) &&
          (!req.body.accountId || a.id === req.body.accountId) &&
          a.enabled &&
          a.approval === "approved" &&
          ![
            "unbound",
            "binding",
            "expired",
            "verification",
            "mismatch",
          ].includes(a.status),
      );
    if (!accounts.length) throw new Error("没有可同步的账号，请先完成扫码登录");
    // Validate the whole request before adding any work.
    if (req.body.from || req.body.to) {
      validateCollectionRange(req.body.from, req.body.to);
    }
    res.status(202).json({
      started: true,
      jobs: accounts.map((a) => jobs.enqueue("sync", a, req.user, req.body)),
    });
  }),
);
app.post(
  "/api/sync/stop",
  route((req, res) => {
    collector.stopping = true;
    res.json({ ok: true });
  }),
);
app.patch(
  "/api/schedule",
  route((req, res) => {
    const { enabled, time, lookback } = req.body;
    const realtimeEnabled =
      req.body.realtimeEnabled ?? store.settings().realtimeEnabled;
    const intervalMinutes =
      req.body.intervalMinutes ?? store.settings().intervalMinutes;
    if (
      typeof enabled !== "boolean" ||
      !/^([01]\d|2[0-3]):[0-5]\d$/.test(time) ||
      !Number.isInteger(lookback) ||
      lookback < 1 ||
      lookback > 7 ||
      typeof realtimeEnabled !== "boolean" ||
      ![1, 3, 5, 10, 15, 30, 60, 180, 360, 720].includes(intervalMinutes)
    )
      throw new Error("定时设置不正确");
    res.json(
      store.setSettings({
        enabled,
        time,
        lookback,
        realtimeEnabled,
        intervalMinutes,
      }),
    );
  }),
);
app.get(
  "/api/export",
  route((req, res) => {
    const r = store.report(
      req.query.month,
      req.reportScope,
      req.query.accountId,
    );
    const detail = req.query.kind === "sessions";
    if (req.query.date) {
      datesBetween(req.query.date, req.query.date);
      if (req.query.date < r.from || req.query.date > r.to)
        throw new Error("日期不在统计月份内");
    }
    const rows = detail
      ? [
          [
            "日期",
            "主播",
            "抖音号",
            "场次ID",
            "开播时间",
            "关播时间",
            "直播时长(秒)",
            "新增粉丝(按场累计)",
            "送礼人数(按场累计)",
            "加粉丝团人数(按场累计)",
            "评论人数(按场累计)",
            "曝光人数(按场累计)",
            "进房人数(按场累计)",
            "进房率(%)",
          ],
          ...r.sessions
            .filter((s) => !req.query.date || s.date === req.query.date)
            .map((s) => [
              s.date,
              s.anchor_name,
              s.handle,
              s.room_id,
              s.start,
              s.end,
              s.duration,
              metricLabels(s).followers || s.followers,
              metricLabels(s).gifters || s.gifters,
              metricLabels(s).fanclub || (s.fanclub ?? "未采集"),
              metricLabels(s).commenters || (s.commenters ?? "未采集"),
              metricLabels(s).exposure || (s.exposure ?? "未采集"),
              metricLabels(s).entrants || (s.entrants ?? "未采集"),
              s.entry_rate ?? "未采集",
            ]),
        ]
      : [
          [
            "日期",
            "直播时长(秒)",
            "新增粉丝(按场累计)",
            "送礼人数(按场累计)",
            "加粉丝团人数(按场累计)",
            "评论人数(按场累计)",
            "曝光人数(按场累计)",
            "进房人数(按场累计)",
            "进房率(%)",
            "场次",
            "已核对账号",
            "应核对账号",
            "状态",
          ],
          ...r.daily.map((d) => [
            d.date,
            d.state === "online_required" ? "需在线提取" : d.duration,
            d.state === "online_required"
              ? "需在线提取"
              : metricLabels(d).followers || d.followers,
            d.state === "online_required"
              ? "需在线提取"
              : metricLabels(d).gifters || d.gifters,
            d.state === "online_required"
              ? "需在线提取"
              : metricLabels(d).fanclub || (d.fanclub ?? "未采集"),
            d.state === "online_required"
              ? "需在线提取"
              : metricLabels(d).commenters || (d.commenters ?? "未采集"),
            d.state === "online_required"
              ? "需在线提取"
              : metricLabels(d).exposure || (d.exposure ?? "未采集"),
            d.state === "online_required"
              ? "需在线提取"
              : metricLabels(d).entrants || (d.entrants ?? "未采集"),
            d.state === "online_required"
              ? "需在线提取"
              : d.entry_rate == null
                ? "未采集"
                : metricLabels(d).entry_rate || Number(d.entry_rate.toFixed(2)),
            d.state === "online_required" ? "需在线提取" : d.sessions,
            d.checked,
            d.expected,
            {
              complete: "已核对",
              partial: "部分采集",
              missing: "未采集",
              pending: "待结算",
              provisional: "今日暂计",
              empty: "未绑定账号",
              online_required: "需在线重新提取",
            }[d.state],
          ]),
        ];
    res.set(
      "Content-Disposition",
      `attachment; filename="live-${r.month}-${detail ? "sessions" : "daily"}.csv"`,
    );
    res
      .type("text/csv; charset=utf-8")
      .send(
        "\uFEFF" + rows.map((row) => row.map(csvCell).join(",")).join("\r\n"),
      );
  }),
);
app.use("/api", (req, res) => res.status(404).json({ error: "接口不存在" }));
if (existsSync(path.join(root, "dist", "index.html"))) {
  app.use(express.static(path.join(root, "dist")));
  app.get("*", (req, res) =>
    res.sendFile(path.join(root, "dist", "index.html")),
  );
} else {
  const { createServer } = await import("vite");
  const vite = await createServer({
    root,
    server: { middlewareMode: true },
    appType: "spa",
  });
  app.use(vite.middlewares);
}
app.use((e, req, res, next) => {
  const message = e.message?.includes("UNIQUE constraint")
    ? "这个抖音号已添加，请直接修改所属主播"
    : e.message?.slice(0, 300) || "操作失败";
  res.status(400).json({ error: message });
});
const port = Number(process.env.PORT || 4173);
const server = app.listen(port, process.env.LIVE_HOST || "127.0.0.1", () =>
  console.log(`Live ledger: http://127.0.0.1:${port}`),
);
server.on("error", (e) => {
  console.error(e.code === "EADDRINUSE" ? `Port ${port} is in use` : e.message);
  process.exit(1);
});
const timer = setInterval(() => {
  guarantees.cleanup();
  try {
    store.cleanupLive();
    cleanupFiles(dataDir);
  } catch (e) {
    console.error("自动存储清理失败，将稍后重试：", e.message);
  }
  guarantees.remind();
  backups.daily();
  const settings = store.settings();
  const daily = scheduleDue(settings),
    realtime = realtimeDue(settings);
  if (!daily && !realtime) return;
  try {
    for (const a of store
      .listAccounts()
      .filter((a) => a.enabled && a.approval === "approved")) {
      if (a.tracking_from > chinaDate()) continue;
      if (
        ["unbound", "binding", "expired", "verification", "mismatch"].includes(
          a.status,
        )
      ) {
        store.notify(a.id, "login", "自动采集等待账号重新登录或验证");
        continue;
      }
      jobs.enqueue(
        "sync",
        a,
        null,
        daily
          ? {}
          : {
              from: [
                shiftDate(chinaDate(), -1),
                `${chinaDate().slice(0, 7)}-01`,
              ].sort()[0],
              to: chinaDate(),
              source: "realtime",
            },
      );
    }
    store.setSettings({
      ...(daily ? { lastDate: chinaDate() } : {}),
      lastRealtimeAt: new Date().toISOString(),
    });
  } catch {}
}, 30000);
timer.unref();
async function shutdown() {
  clearInterval(timer);
  server.close();
  await jobs.close();
  store.close();
  process.exit(0);
}
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
