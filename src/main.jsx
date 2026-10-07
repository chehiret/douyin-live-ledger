import React, { useState, useEffect, useRef } from "react";
import { createRoot } from "react-dom/client";
import {
  Activity,
  LayoutDashboard,
  Users,
  History,
  Settings,
  Plus,
  ChevronLeft,
  ChevronRight,
  Download,
  RefreshCw,
  Clock,
  UserPlus,
  Gift,
  Radio,
  Search,
  MoreHorizontal,
  X,
  Check,
  AlertCircle,
  ScanLine,
  Pencil,
  Link2,
  CalendarDays,
  Pause,
  ArrowUpRight,
  CheckCircle2,
  Loader2,
  Monitor,
  ExternalLink,
  WifiOff,
  ShieldCheck,
  KeyRound,
  LogOut,
  ListOrdered,
  Bell,
  Database,
  ClipboardList,
  MessageSquare,
  Heart,
  Trash2,
} from "lucide-react";
import { AuthGate, UserAccessForm, PasswordForm } from "./auth-ui.jsx";
import { Operations, Verification } from "./operations.jsx";
import { GuaranteeCards, GuaranteeForm } from "./guarantees.jsx";
import "./style.css";
import { metricText } from "../shared/metrics.js";

const nf = new Intl.NumberFormat("zh-CN");
const count = (n) => nf.format(n || 0);
function duration(s = 0) {
  const h = Math.floor(s / 3600),
    m = Math.floor((s % 3600) / 60),
    sec = s % 60;
  return `${h}时${String(m).padStart(2, "0")}分${String(sec).padStart(2, "0")}秒`;
}
function localTime(s) {
  return s
    ? new Date(s).toLocaleString("zh-CN", {
        timeZone: "Asia/Shanghai",
        hour12: false,
      })
    : "尚未同步";
}
const nowMonth = () =>
  new Date(Date.now() + 8 * 3600000).toISOString().slice(0, 7);
const pageTitles = {
  overview: "直播数据",
  anchors: "主播与账号",
  logs: "同步记录",
  settings: "同步设置",
  jobs: "任务队列",
  notices: "通知中心",
  audits: "操作记录",
  backups: "数据备份",
};
function pageFromUrl() {
  const page = window.location.hash.slice(1);
  return Object.hasOwn(pageTitles, page) ? page : "overview";
}
async function api(url, options = {}) {
  const res = await fetch(url, {
    ...options,
    headers: { "Content-Type": "application/json", ...options.headers },
  });
  const data = await res.json();
  if (res.status === 401) window.dispatchEvent(new Event("auth-expired"));
  if (!res.ok) throw new Error(data.error || "请求失败");
  return data;
}
const send = (url, method, body) =>
  api(url, { method, body: JSON.stringify(body) });
const statusMap = {
  ready: ["已登录", "green"],
  expired: ["登录失效", "red"],
  error: ["同步异常", "red"],
  unbound: ["待绑定", "gray"],
  binding: ["扫码中", "amber"],
  syncing: ["同步中", "green"],
  verification: ["需要验证", "amber"],
  mismatch: ["需核对账号", "amber"],
};
const loginResultMap = {
  valid: ["登录有效", "green"],
  expired: ["登录失效", "red"],
  verification: ["需要验证", "amber"],
  mismatch: ["需核对账号", "amber"],
  unknown: ["无法确认", "gray"],
};
const dailyState = {
  complete: ["已核对", "green"],
  partial: ["部分采集", "amber"],
  missing: ["未采集", "gray"],
  online_required: ["需在线重新提取", "gray"],
  pending: ["待结算", "gray"],
  provisional: ["今日暂计", "amber"],
  empty: ["无账号", "gray"],
};
function Badge({ status, kind = "account" }) {
  const [text, color] = (kind === "day"
    ? dailyState
    : kind === "loginCheck"
      ? loginResultMap
      : statusMap)[status] || [status, "gray"];
  return (
    <span className={`badge ${color}`}>
      <i />
      {text}
    </span>
  );
}
function IconButton({ icon: Icon, label, ...props }) {
  return (
    <button className="icon-button" title={label} aria-label={label} {...props}>
      <Icon size={17} />
    </button>
  );
}
function Avatar({ name, size = "" }) {
  return <span className={`avatar ${size}`}>{name?.slice(0, 1) || "主"}</span>;
}
function Empty({ icon: Icon = Radio, title, action }) {
  return (
    <div className="empty">
      <Icon size={32} strokeWidth={1.4} />
      <p>{title}</p>
      {action}
    </div>
  );
}
function Modal({ title, children, onClose, wide = false }) {
  const ref = useRef();
  useEffect(() => {
    const old = document.activeElement;
    ref.current?.focus();
    const listener = (e) => {
      if (e.key === "Escape") onClose();
      if (e.key === "Tab") {
        const nodes = ref.current.querySelectorAll(
          'button:not([disabled]),input,select,textarea,[tabindex="0"]',
        );
        if (!nodes.length) return;
        const first = nodes[0],
          last = nodes[nodes.length - 1];
        if (e.shiftKey && document.activeElement === first) {
          e.preventDefault();
          last.focus();
        } else if (!e.shiftKey && document.activeElement === last) {
          e.preventDefault();
          first.focus();
        }
      }
    };
    document.addEventListener("keydown", listener);
    return () => {
      document.removeEventListener("keydown", listener);
      old?.focus();
    };
  }, []);
  return (
    <div
      className="modal-backdrop"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <section
        className={`modal ${wide ? "wide" : ""}`}
        ref={ref}
        role="dialog"
        aria-modal="true"
        aria-label={title}
        tabIndex={-1}
      >
        <header>
          <h2>{title}</h2>
          <IconButton icon={X} label="关闭" onClick={onClose} />
        </header>
        {children}
      </section>
    </div>
  );
}
function TeamForm({ anchor, anchors, onClose, onSave }) {
  const [isLeader, setLeader] = useState(Boolean(anchor.is_leader)),
    [leaderId, setLeaderId] = useState(anchor.leader_id || ""),
    [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  const members = anchors.filter((a) => a.leader_id === anchor.id);
  return (
    <Modal title={`${anchor.name} · 组长与归属`} onClose={onClose}>
      <form
        onSubmit={async (e) => {
          e.preventDefault();
          setBusy(true);
          setError("");
          try {
            await send(`/api/anchors/${anchor.id}/team`, "PUT", {
              isLeader,
              leaderId,
            });
            await onSave();
            onClose();
          } catch (e) {
            setError(e.message);
          } finally {
            setBusy(false);
          }
        }}
      >
        <label>
          主播身份
          <select
            disabled={busy}
            value={isLeader ? "leader" : "anchor"}
            onChange={(e) => {
              setLeader(e.target.value === "leader");
              setLeaderId("");
            }}
          >
            <option value="anchor">普通主播</option>
            <option value="leader">组长</option>
          </select>
        </label>
        {!isLeader && (
          <label>
            归属组长
            <select
              disabled={busy}
              value={leaderId}
              onChange={(e) => setLeaderId(e.target.value)}
            >
              <option value="">未分组</option>
              {anchors
                .filter((a) => a.is_leader && a.id !== anchor.id)
                .map((a) => (
                  <option key={a.id} value={a.id}>
                    {a.name}
                  </option>
                ))}
            </select>
          </label>
        )}
        <p className="muted">
          组长使用原登录账号查看自己及名下主播的数据。组员的账号操作和月度保底设置仍由原有权限控制。
        </p>
        {members.length > 0 && (
          <p>
            名下主播：{members.map((a) => a.name).join("、")}
            。取消组长前，请先调整这些主播的归属。
          </p>
        )}
        {error && <p className="form-error">{error}</p>}
        <footer>
          <button type="button" className="button" onClick={onClose}>
            取消
          </button>
          <button className="button primary" disabled={busy}>
            保存分组
          </button>
        </footer>
      </form>
    </Modal>
  );
}
function AnchorForm({ anchor, onClose, onSave }) {
  const [name, setName] = useState(anchor?.name || ""),
    [note, setNote] = useState(anchor?.note || ""),
    [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  return (
    <Modal title={anchor ? "编辑主播" : "添加主播"} onClose={onClose}>
      <form
        onSubmit={async (e) => {
          e.preventDefault();
          setBusy(true);
          try {
            await send(
              anchor ? `/api/anchors/${anchor.id}` : "/api/anchors",
              anchor ? "PATCH" : "POST",
              { name, note },
            );
            await onSave();
            onClose();
          } catch (e) {
            setError(e.message);
          } finally {
            setBusy(false);
          }
        }}
      >
        <label>
          主播名称
          <input
            autoFocus
            required
            maxLength={60}
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="姓名或内部称呼"
          />
        </label>
        <label>
          主播备注
          <textarea
            maxLength={1000}
            rows={3}
            value={note}
            onChange={(e) => setNote(e.target.value)}
            placeholder="团队、分组或其他备注"
          />
        </label>
        {error && <p className="form-error">{error}</p>}
        <footer>
          <button type="button" className="button" onClick={onClose}>
            取消
          </button>
          <button className="button primary" disabled={busy}>
            <Check size={16} />
            保存主播
          </button>
        </footer>
      </form>
    </Modal>
  );
}
function AccountForm({
  account,
  anchors,
  initialAnchor,
  onClose,
  onSave,
  onLogin,
  isAdmin,
}) {
  const [anchorId, setAnchor] = useState(
      account?.anchor_id || initialAnchor || anchors[0]?.id || "",
    ),
    [note, setNote] = useState(account?.note || ""),
    [enabled, setEnabled] = useState(account?.enabled !== 0),
    [trackingFrom, setTrackingFrom] = useState(
      account?.tracking_from || nowMonth() + "-01",
    ),
    [error, setError] = useState(""),
    [busy, setBusy] = useState(false);
  return (
    <Modal title={account ? "编辑抖音号" : "添加抖音号"} onClose={onClose}>
      <form
        onSubmit={async (e) => {
          e.preventDefault();
          setBusy(true);
          try {
            const result = await send(
              account ? `/api/accounts/${account.id}` : "/api/accounts",
              account ? "PATCH" : "POST",
              {
                anchorId,
                note,
                enabled,
                trackingFrom: isAdmin ? trackingFrom : undefined,
              },
            );
            await onSave();
            onClose();
            if (!account) onLogin(result);
          } catch (e) {
            setError(e.message);
          } finally {
            setBusy(false);
          }
        }}
      >
        <label>
          所属主播
          <select
            aria-label="所属主播"
            required
            value={anchorId}
            onChange={(e) => setAnchor(e.target.value)}
          >
            {anchors.map((a) => (
              <option key={a.id} value={a.id}>
                {a.name}
              </option>
            ))}
          </select>
        </label>
        {account?.douyin_handle && (
          <label>
            抖音号
            <input readOnly value={account.douyin_handle} />
          </label>
        )}
        {!account && (
          <p className="muted">
            扫码后自动识别昵称和抖音号，无需手动输入；未获取到抖音号时不显示该项。
          </p>
        )}
        <label>
          账号备注
          <textarea
            rows={3}
            maxLength={1000}
            value={note}
            onChange={(e) => setNote(e.target.value)}
            placeholder="例如：主号、备用号"
          />
        </label>
        {account && (
          <>
            {isAdmin && (
              <label>
                统计起始日期
                <input
                  type="date"
                  required
                  value={trackingFrom}
                  onChange={(e) => setTrackingFrom(e.target.value)}
                />
              </label>
            )}
            <label className="checkbox-row">
              <input
                type="checkbox"
                checked={enabled}
                onChange={(e) => setEnabled(e.target.checked)}
              />
              参与自动同步
            </label>
            {anchorId !== account.anchor_id && (
              <div className="notice amber">
                归属修改后，这个账号已保存的历史数据也会归入所选主播。
              </div>
            )}
          </>
        )}
        {error && <p className="form-error">{error}</p>}
        <footer>
          <button type="button" className="button" onClick={onClose}>
            取消
          </button>
          <button className="button primary" disabled={busy}>
            {account ? <Check size={16} /> : <ScanLine size={16} />}
            {account ? "保存修改" : "保存并扫码"}
          </button>
        </footer>
      </form>
    </Modal>
  );
}
function LoginModal({ account, onClose, onSave }) {
  const [phase, setPhase] = useState("opening"),
    [message, setMessage] = useState("正在打开抖音官方登录页面"),
    [tick, setTick] = useState(0),
    [qrLoaded, setQrLoaded] = useState(false),
    [canShow, setCanShow] = useState(false),
    [elapsed, setElapsed] = useState(0),
    [error, setError] = useState("");
  const [verification, setVerification] = useState(false);
  useEffect(() => {
    if (phase === "verification") setVerification(true);
    if (["finishing", "mismatch", "ready"].includes(phase))
      setVerification(false);
  }, [phase]);
  const disposed = useRef(false),
    ready = useRef(false),
    qrPoll = useRef(0),
    polling = useRef(false);
  const showVerification =
    verification && !["finishing", "mismatch", "ready"].includes(phase);
  async function acceptStatus(r) {
    if (disposed.current) return;
    setPhase(r.phase);
    setMessage(r.message);
    setCanShow(Boolean(r.canShow));
    if (r.phase === "ready" && !ready.current) {
      ready.current = true;
      try {
        await onSave();
        if (!disposed.current) onClose();
      } catch (e) {
        ready.current = false;
        throw e;
      }
    }
  }
  async function start(visible = false) {
    setError("");
    setPhase("opening");
    setQrLoaded(false);
    setElapsed(0);
    try {
      const r = await send(`/api/accounts/${account.id}/login`, "POST", {
        visible,
      });
      if (!disposed.current) {
        setPhase(r.phase);
        setMessage(r.message);
        setCanShow(Boolean(r.canShow));
        setTick(Date.now());
      }
    } catch (e) {
      setError(e.message);
      setPhase("error");
    }
  }
  useEffect(() => {
    disposed.current = false;
    start();
    const timer = setInterval(async () => {
      if (polling.current || ready.current) return;
      polling.current = true;
      try {
        const r = await api(`/api/accounts/${account.id}/login`);
        if (disposed.current) return;
        setElapsed((v) => v + 3);
        if (++qrPoll.current % 3 === 0) setTick(Date.now());
        await acceptStatus(r);
      } catch (e) {
        if (!disposed.current) setError(e.message);
      } finally {
        polling.current = false;
      }
    }, 3000);
    return () => {
      disposed.current = true;
      clearInterval(timer);
    };
  }, []);
  async function close() {
    if (!["ready", "error", "unbound"].includes(phase))
      await api(`/api/accounts/${account.id}/login`, {
        method: "DELETE",
      }).catch(() => {});
    await onSave();
    onClose();
  }
  return (
    <Modal
      title={
        account.nickname ? `绑定抖音号 · ${account.nickname}` : "扫码绑定抖音号"
      }
      onClose={close}
      wide={showVerification}
    >
      {showVerification && (
        <Verification
          account={account}
          inline
          onStatus={acceptStatus}
          onClose={() => setVerification(false)}
        />
      )}
      {!showVerification && (
        <div className="login-body">
          {["ready", "finishing"].includes(phase) ? (
            <div className="login-success">
              <Loader2 className="spin" size={32} />
              <p>正在保存登录状态，即将自动关闭…</p>
            </div>
          ) : (
            <>
              <div className="qr-frame">
                {phase === "mismatch" ? (
                  <div className="verification-prompt">
                    <AlertCircle size={36} />
                    <h3>账号需要核对</h3>
                    <p>请关闭弹窗，核对已有账号记录。</p>
                  </div>
                ) : phase === "verification" ? (
                  <div className="verification-prompt">
                    <AlertCircle size={36} />
                    <h3>需要完成登录验证</h3>
                    <button
                      className="button primary"
                      onClick={() => setVerification(true)}
                    >
                      <Monitor size={16} />
                      打开官方验证
                    </button>
                  </div>
                ) : phase === "scanned" ? (
                  <div className="verification-prompt">
                    <CheckCircle2 size={36} />
                    <h3>扫码成功</h3>
                    <p>等待手机确认</p>
                  </div>
                ) : ["error", "unbound", "cancelled"].includes(phase) ? (
                  <div className="verification-prompt">
                    <AlertCircle size={36} />
                    <h3>登录尚未完成</h3>
                    <button className="button primary" onClick={() => start()}>
                      重新开始扫码
                    </button>
                  </div>
                ) : (
                  !qrLoaded &&
                  (phase === "queued" ? (
                    <div className="verification-prompt">
                      <Clock size={36} />
                      <h3>扫码优先排队中</h3>
                      <p>可关闭弹窗取消等待</p>
                    </div>
                  ) : elapsed >= 30 ? (
                    <div className="verification-prompt">
                      <AlertCircle size={36} />
                      <h3>二维码暂未显示</h3>
                      <p>请刷新二维码，或打开下方官方登录页。</p>
                    </div>
                  ) : (
                    <Loader2 className="spin qr-loading" size={30} />
                  ))
                )}
                {phase === "waiting" ? (
                  <img
                    src={`/api/accounts/${account.id}/qr?t=${tick}`}
                    alt="抖音官方登录二维码"
                    style={{ visibility: qrLoaded ? "visible" : "hidden" }}
                    onError={() => setQrLoaded(false)}
                    onLoad={() => setQrLoaded(true)}
                  />
                ) : null}
              </div>
              <p className="login-status">{message || "等待登录"}</p>
              {phase === "queued" && elapsed >= 30 && (
                <p className="muted">
                  已等待 {elapsed}{" "}
                  秒。扫码会优先于未开始的同步任务；不会中断正在处理的数据。
                </p>
              )}
              <p className="muted">扫码及身份验证均在当前弹窗完成。</p>
            </>
          )}
          {error && <p className="form-error">{error}</p>}
        </div>
      )}
      {!showVerification && !["ready", "finishing"].includes(phase) && (
        <footer>
          {phase === "mismatch" ? (
            <button className="button primary" onClick={close}>
              <Check size={16} />
              关闭
            </button>
          ) : (
            <>
              <button
                className="button"
                disabled={!canShow}
                onClick={() => setVerification(true)}
              >
                打开官方登录页
              </button>
              <button
                className="button"
                onClick={async () => {
                  try {
                    await send(
                      `/api/accounts/${account.id}/login/refresh`,
                      "POST",
                      {},
                    );
                    setTick(Date.now());
                  } catch (e) {
                    setError(e.message);
                  }
                }}
                disabled={!canShow}
              >
                <RefreshCw size={16} />
                刷新二维码
              </button>
            </>
          )}
        </footer>
      )}
    </Modal>
  );
}
function Backfill({ accounts, month, onClose, onSave }) {
  const today = new Date(Date.now() + 8 * 3600000).toISOString().slice(0, 10),
    latest = today,
    floor = "2020-01-01";
  const [accountId, setAccount] = useState(""),
    [from, setFrom] = useState(
      `${month}-01` < floor
        ? floor
        : `${month}-01` > latest
          ? latest
          : `${month}-01`,
    ),
    [to, setTo] = useState(
      `${month}-${new Date(Number(month.slice(0, 4)), Number(month.slice(5)), 0).getDate()}` <
        latest
        ? `${month}-${new Date(Number(month.slice(0, 4)), Number(month.slice(5)), 0).getDate()}`
        : latest,
    ),
    [error, setError] = useState(""),
    [busy, setBusy] = useState(false);
  return (
    <Modal title="补采历史数据" onClose={onClose}>
      <form
        onSubmit={async (e) => {
          e.preventDefault();
          setBusy(true);
          try {
            await send("/api/sync", "POST", {
              accountId: accountId || undefined,
              from,
              to,
            });
            await onSave();
            onClose();
          } catch (e) {
            setError(e.message);
          } finally {
            setBusy(false);
          }
        }}
      >
        <p className="muted">
          本地保留当月及前两个月。更早记录需在线重新提取，结果仅在服务器内存保留30分钟，可及时导出；是否可提取以抖音实际提供范围为准。一次最多100天。
        </p>
        <label>
          抖音账号
          <select
            value={accountId}
            onChange={(e) => setAccount(e.target.value)}
          >
            <option value="">全部已绑定账号</option>
            {accounts
              .filter((a) => a.enabled)
              .map((a) => (
                <option key={a.id} value={a.id}>
                  {a.nickname || a.handle || "待扫码账号"} · {a.anchor_name}
                </option>
              ))}
          </select>
        </label>
        <div className="form-grid">
          <label>
            开始日期
            <input
              type="date"
              required
              min={floor}
              max={latest}
              value={from}
              onChange={(e) => setFrom(e.target.value)}
            />
          </label>
          <label>
            结束日期
            <input
              type="date"
              required
              min={from}
              max={latest}
              value={to}
              onChange={(e) => setTo(e.target.value)}
            />
          </label>
        </div>
        {error && <p className="form-error">{error}</p>}
        <footer>
          <button type="button" className="button" onClick={onClose}>
            取消
          </button>
          <button className="button primary" disabled={busy}>
            <RefreshCw size={16} />
            开始补采
          </button>
        </footer>
      </form>
    </Modal>
  );
}
function Trend({ daily, metric }) {
  const values = daily.map((d) => d[metric]);
  const max = Math.max(...values, 1);
  return (
    <div className="trend" role="img" aria-label="本月每日数据柱状图">
      <div className="y-axis">
        <span>
          {metric === "duration" ? `${(max / 3600).toFixed(1)}h` : count(max)}
        </span>
        <span>
          {metric === "duration"
            ? `${(max / 7200).toFixed(1)}h`
            : count(Math.round(max / 2))}
        </span>
        <span>0</span>
      </div>
      <div className="plot">
        <div className="grid-line top" />
        <div className="grid-line middle" />
        <div className="grid-line bottom" />
        {daily.map((d, i) => (
          <div
            className="bar-column"
            key={d.date}
            title={`${d.date} · ${d.state === "online_required" ? "需在线重新提取" : d.state === "missing" ? "未采集" : metric === "duration" ? duration(d.duration) : metricText(d, metric)}`}
          >
            <div
              className={`bar ${metric} ${["missing", "online_required"].includes(d.state) ? "unknown" : ""}`}
              style={{
                height: `${(values[i] / max) * 100}%`,
                minHeight: values[i] ? 3 : 0,
              }}
            />
            <span>
              {i === 0 || (i + 1) % 5 === 0 || i === daily.length - 1
                ? i + 1
                : ""}
            </span>
          </div>
        ))}
      </div>
    </div>
  );
}
function App({ user, onLogout }) {
  const isAdmin = user.role === "admin";
  const [state, setState] = useState(null),
    [report, setReport] = useState(null),
    [page, setPage] = useState(() =>
      !isAdmin && ["settings", "audits", "backups"].includes(pageFromUrl())
        ? "overview"
        : pageFromUrl(),
    ),
    [month, setMonth] = useState(nowMonth()),
    [anchorId, setAnchor] = useState(""),
    [accountId, setAccount] = useState(""),
    [view, setView] = useState("daily"),
    [sessionDate, setSessionDate] = useState(""),
    [metric, setMetric] = useState("duration"),
    [query, setQuery] = useState(""),
    [modal, setModal] = useState(null),
    [toast, setToast] = useState(null),
    [error, setError] = useState(""),
    [loading, setLoading] = useState(true),
    [pendingCheck, setPendingCheck] = useState(null),
    [pendingSync, setPendingSync] = useState(null),
    [pendingExport, setPendingExport] = useState(null),
    [runPage, setRunPage] = useState(1),
    [runData, setRunData] = useState({ items: [], total: 0 }),
    [expanded, setExpanded] = useState(() => new Set());
  const request = useRef(0),
    paramsRef = useRef({ month, anchorId, accountId });
  paramsRef.current = { month, anchorId, accountId };
  const notify = (text, type = "success") => {
    setToast({ text, type });
    setTimeout(() => setToast(null), 5000);
  };
  async function refresh() {
    const serial = ++request.current;
    const p = paramsRef.current;
    try {
      const s = await api("/api/state");
      if (serial !== request.current) return;
      setState(s);
      // Revoke stale selections and cached data when an administrator moves a member.
      if (
        (p.anchorId && !s.anchors.some((a) => a.id === p.anchorId)) ||
        (p.accountId && !s.accounts.some((a) => a.id === p.accountId))
      ) {
        setReport(null);
        setAnchor("");
        setAccount("");
        setModal(null);
        return;
      }
      const r = await api("/api/report?" + new URLSearchParams(p));
      if (serial === request.current) {
        setState(s);
        setReport(r);
        setError("");
      }
    } catch (e) {
      if (serial === request.current) {
        setReport(null);
        setError(e.message);
      }
    } finally {
      if (serial === request.current) setLoading(false);
    }
  }
  useEffect(() => {
    setLoading(true);
    setExpanded(new Set());
    refresh();
  }, [month, anchorId, accountId]);
  useEffect(() => {
    setSessionDate("");
  }, [month]);
  useEffect(() => {
    const t = setInterval(refresh, 5000);
    return () => clearInterval(t);
  }, []);
  useEffect(() => {
    if (page !== "logs") return;
    let disposed = false;
    const load = () =>
      api(`/api/runs?page=${runPage}`)
        .then((r) => {
          if (!disposed) {
            setRunData(r);
            if (runPage > Math.max(1, Math.ceil(r.total / 15)))
              setRunPage(Math.max(1, Math.ceil(r.total / 15)));
          }
        })
        .catch((e) => {
          if (!disposed) setError(e.message);
        });
    load();
    const t = setInterval(load, 5000);
    return () => {
      disposed = true;
      clearInterval(t);
    };
  }, [page, runPage]);
  useEffect(() => {
    const restorePage = () =>
      setPage(
        !isAdmin && ["settings", "audits", "backups"].includes(pageFromUrl())
          ? "overview"
          : pageFromUrl(),
      );
    window.addEventListener("hashchange", restorePage);
    return () => window.removeEventListener("hashchange", restorePage);
  }, []);
  function navigatePage(id) {
    window.location.hash = id;
    setPage(id);
  }
  async function sync() {
    try {
      await send("/api/sync", "POST", {});
      await refresh();
      notify("同步请求已加入队列");
    } catch (e) {
      notify(e.message, "error");
    }
  }
  async function syncAccount(account) {
    setPendingSync(account.id);
    try {
      await send("/api/sync", "POST", { accountId: account.id });
      await refresh();
      notify(
        "已加入同步队列：检测登录后补齐当月缺失数据，已核对的历史日期跳过",
      );
    } catch (e) {
      notify(e.message, "error");
    } finally {
      setPendingSync(null);
    }
  }
  const accounts = state?.accounts || [],
    anchors = state?.anchors || [],
    roleLabel = isAdmin ? "管理员" : state?.user?.is_leader ? "组长" : "主播",
    ownAccounts = accounts.filter(
      (a) => isAdmin || a.anchor_id === user.anchor_id,
    ),
    checking = pendingCheck || state?.checking,
    busy = state?.sync?.busy || checking || state?.binding;
  async function checkAccount(account) {
    setPendingCheck(account.id);
    try {
      const result = await send(
        `/api/accounts/${account.id}/login/check`,
        "POST",
        {},
      );
      notify(
        result.result
          ? `${loginResultMap[result.result][0]}：${result.message}`
          : "登录检测已加入队列",
      );
    } catch (e) {
      notify(e.message, "error");
    } finally {
      await refresh();
      setPendingCheck(null);
    }
  }
  async function exportCookies(account) {
    if (pendingExport) return;
    setPendingExport(account.id);
    let downloadUrl;
    try {
      const response = await fetch(
        `/api/accounts/${account.id}/cookies/export`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: "{}",
        },
      );
      if (response.status === 401)
        window.dispatchEvent(new Event("auth-expired"));
      if (!response.ok) {
        const data = await response.json();
        throw new Error(data.error || "Cookie 导出失败");
      }
      downloadUrl = URL.createObjectURL(await response.blob());
      const link = document.createElement("a");
      link.href = downloadUrl;
      link.download = `douyin-cookies-${account.douyin_handle || account.id}.json`;
      document.body.appendChild(link);
      link.click();
      link.remove();
      notify(
        "Cookie JSON 已下载；打开抖音主播后台，在 Cookie-Editor 的 Import 中粘贴文件内容。",
      );
    } catch (e) {
      notify(e.message, "error");
    } finally {
      if (downloadUrl) setTimeout(() => URL.revokeObjectURL(downloadUrl), 1000);
      setPendingExport(null);
    }
  }
  function changeMonth(delta) {
    const [y, m] = month.split("-").map(Number);
    const d = new Date(Date.UTC(y, m - 1 + delta, 1));
    setMonth(d.toISOString().slice(0, 7));
  }
  const title = pageTitles[page];
  const activeAccounts = accounts.filter((a) => a.enabled),
    issues = activeAccounts.filter((a) =>
      ["error", "expired", "verification", "mismatch"].includes(a.status),
    );
  const login = (a) => setModal({ type: "login", account: a });
  const anchorForm = (a) => setModal({ type: "anchor", anchor: a });
  const exportUrl =
    "/api/export?" +
    new URLSearchParams({
      month,
      anchorId,
      accountId,
      kind: view === "sessions" ? "sessions" : "daily",
      ...(view === "sessions" && sessionDate ? { date: sessionDate } : {}),
    });
  return (
    <div className="app-shell">
      <aside className="sidebar">
        <div className="brand">
          <span className="brand-icon">
            <Activity size={24} />
          </span>
          <div>
            <strong>主播数据管理器</strong>
            <small>LIVE LEDGER</small>
          </div>
        </div>
        <div className="workspace-label">工作台</div>
        <nav>
          {[
            [LayoutDashboard, "overview", "直播数据"],
            [Users, "anchors", "主播与账号"],
            [History, "logs", "同步记录"],
            [Settings, "settings", "同步设置"],
            [ListOrdered, "jobs", "任务队列"],
            [Bell, "notices", "通知中心"],
            [ClipboardList, "audits", "操作记录"],
            [Database, "backups", "数据备份"],
          ]
            .filter(
              ([, id]) =>
                isAdmin || !["settings", "audits", "backups"].includes(id),
            )
            .map(([Icon, id, text]) => (
              <button
                key={id}
                aria-label={text}
                title={text}
                className={page === id ? "nav-item active" : "nav-item"}
                onClick={() => navigatePage(id)}
              >
                <Icon size={18} />
                <span>{text}</span>
                {id === "anchors" && issues.length > 0 && (
                  <i className="notification-dot" />
                )}
                {id === "notices" &&
                  state?.notices?.some((n) => !n.is_read && !n.resolved) && (
                    <i className="notification-dot" />
                  )}
              </button>
            ))}
        </nav>
        <div className="sidebar-bottom">
          <span className={`connection-dot ${error ? "offline" : ""}`} />
          <span>{error ? "服务连接异常" : "本地工作空间"}</span>
          <small>北京时间 · UTC+8</small>
        </div>
      </aside>
      <div className="content-shell">
        <div className="topbar">
          <span className="breadcrumb">
            工作台 <ChevronRight size={13} /> {title}
          </span>
          <div className="topbar-right">
            <span className="live-dot" />
            {checking
              ? "正在检测登录"
              : state?.sync?.busy
                ? "正在同步"
                : state?.binding
                  ? "正在登录"
                  : !state?.schedule.enabled
                    ? "自动同步已暂停"
                    : state?.schedule.realtimeEnabled
                      ? "定时更新中"
                      : "每日自动记录"}
            <span className="separator" />
            <span
              className="session-user"
              title={`${user.username} · ${roleLabel}`}
            >
              {user.username} · {roleLabel}
            </span>
            <IconButton
              icon={KeyRound}
              label="修改登录密码"
              onClick={() => setModal({ type: "password" })}
            />
            <IconButton icon={LogOut} label="退出登录" onClick={onLogout} />
          </div>
        </div>
        <main>
          <header className="page-header">
            <div>
              <div className="eyebrow">
                {page === "overview"
                  ? "MONTHLY OVERVIEW"
                  : page === "anchors"
                    ? "ANCHORS & ACCOUNTS"
                    : page === "logs"
                      ? "SYNC HISTORY"
                      : {
                          settings: "SCHEDULE",
                          jobs: "TASK QUEUE",
                          notices: "NOTIFICATIONS",
                          audits: "ACTIVITY LOG",
                          backups: "BACKUPS",
                        }[page] || ""}
              </div>
              <h1>{title}</h1>
            </div>
            <div className="header-actions">
              {page === "overview" ? (
                <>
                  <button
                    className="button"
                    onClick={() => setModal({ type: "backfill" })}
                    disabled={!ownAccounts.length}
                  >
                    <History size={16} />
                    {state?.user?.is_leader ? "补采我的账号" : "补采数据"}
                  </button>
                  <button
                    className="button primary"
                    onClick={sync}
                    disabled={!ownAccounts.length}
                  >
                    <RefreshCw
                      size={16}
                      className={state?.sync?.busy ? "spin" : ""}
                    />
                    {state?.sync?.busy
                      ? "同步中"
                      : state?.user?.is_leader
                        ? "同步我的账号"
                        : "立即同步"}
                  </button>
                </>
              ) : page === "anchors" && isAdmin ? (
                <button className="button primary" onClick={() => anchorForm()}>
                  <Plus size={16} />
                  添加主播
                </button>
              ) : null}
            </div>
          </header>
          {error && (
            <div className="notice red">
              <WifiOff size={18} />
              {error}
              <button className="text-button" onClick={refresh}>
                重试
              </button>
            </div>
          )}
          {page !== "notices" &&
            state?.notices?.some((n) => !n.resolved && !n.is_read) && (
              <div className="notice amber">
                <Bell size={17} />
                <span>
                  {
                    state.notices.filter((n) => !n.resolved && !n.is_read)
                      .length
                  }{" "}
                  条待处理提醒
                </span>
                <button
                  className="text-button"
                  onClick={() => navigatePage("notices")}
                >
                  查看
                </button>
              </div>
            )}
          {page !== "jobs" &&
            state?.jobs?.some((j) => j.status === "queued") && (
              <div className="notice green">
                <ListOrdered size={17} />
                <span>
                  {state.jobs.filter((j) => j.status === "queued").length}{" "}
                  个任务等待处理
                </span>
                <button
                  className="text-button"
                  onClick={() => navigatePage("jobs")}
                >
                  查看队列
                </button>
              </div>
            )}
          {state?.sync?.busy && (
            <div className="notice green">
              <Loader2 size={17} className="spin" />
              <span>
                {state.sync.progress
                  ? `${state.sync.progress.handle} · ${state.sync.progress.date} · ${state.sync.progress.message}`
                  : "正在启动同步任务"}
              </span>
              {isAdmin && (
                <button
                  className="text-button"
                  onClick={async () => {
                    await send("/api/sync/stop", "POST", {});
                    notify("将在当前步骤结束后停止");
                  }}
                >
                  停止
                </button>
              )}
            </div>
          )}
          {page === "overview" && (
            <>
              {report?.retention && (
                <div className="notice amber">
                  <History size={17} />
                  <span>
                    {report.retention.historical
                      ? "该月份不在本地保留范围。由管理员或账号本人在线重新提取后，可在30分钟内查看及导出；抖音不再提供的历史无法恢复。"
                      : `本地直播记录保留自 ${report.retention.from} 起的3个自然月，操作日志保留7天。`}
                  </span>
                  {report.retention.historical && ownAccounts.length > 0 && (
                    <button
                      className="text-button"
                      onClick={() => setModal({ type: "backfill" })}
                    >
                      在线重新提取
                    </button>
                  )}
                </div>
              )}
              <section className="filters">
                <div className="month-control">
                  <IconButton
                    icon={ChevronLeft}
                    label="上个月"
                    onClick={() => changeMonth(-1)}
                  />
                  <CalendarDays size={17} />
                  <input
                    aria-label="统计月份"
                    type="month"
                    value={month}
                    min="2020-01"
                    max="2100-12"
                    onChange={(e) => {
                      if (e.target.value) setMonth(e.target.value);
                    }}
                  />
                  <IconButton
                    icon={ChevronRight}
                    label="下个月"
                    onClick={() => changeMonth(1)}
                  />
                </div>
                <select
                  aria-label="筛选主播"
                  value={anchorId}
                  onChange={(e) => {
                    setAnchor(e.target.value);
                    setAccount("");
                  }}
                >
                  <option value="">全部主播</option>
                  {anchors.map((a) => (
                    <option key={a.id} value={a.id}>
                      {a.name}
                    </option>
                  ))}
                </select>
                <select
                  aria-label="筛选抖音号"
                  value={accountId}
                  onChange={(e) => setAccount(e.target.value)}
                >
                  <option value="">全部抖音号</option>
                  {accounts
                    .filter((a) => !anchorId || a.anchor_id === anchorId)
                    .map((a) => (
                      <option key={a.id} value={a.id}>
                        {a.nickname || a.handle || "待扫码账号"}
                      </option>
                    ))}
                </select>
                <span className="period">
                  {report?.from.replaceAll("-", " / ")} —{" "}
                  {report?.to.replaceAll("-", " / ")}
                </span>
              </section>
              {issues.length > 0 && (
                <div className="notice amber">
                  <AlertCircle size={17} />
                  <span>
                    {issues.length} 个账号需要处理，月度数据可能不完整
                  </span>
                  <button
                    className="text-button"
                    onClick={() => navigatePage("anchors")}
                  >
                    查看账号 <ArrowUpRight size={14} />
                  </button>
                </div>
              )}
              {state?.user?.is_leader && (
                <p className="muted">
                  可查看自己及名下主播的数据，使用上方筛选可分别查看。月度保底由管理员设置。
                </p>
              )}
              <section className={`metrics ${loading ? "loading" : ""}`}>
                {[
                  [Clock, "直播时长", "duration", "teal"],
                  [UserPlus, "新增粉丝", "followers", "blue"],
                  [Gift, "送礼人数", "gifters", "pink"],
                  [Radio, "直播场次", "sessions", "gold"],
                  [Heart, "加粉丝团人数", "fanclub", "teal"],
                  [MessageSquare, "评论人数", "commenters", "blue"],
                  [Users, "曝光人数", "exposure", "teal"],
                  [Users, "进房人数", "entrants", "blue"],
                  [ArrowUpRight, "平均进房率", "entry_rate", "gold"],
                ].map(([Icon, label, key, color]) => (
                  <div className="metric" key={key}>
                    <div className="metric-label">
                      <span>{label}</span>
                      <span className={`metric-icon ${color}`}>
                        <Icon size={18} />
                      </span>
                    </div>
                    <div
                      className={`metric-value ${key === "duration" ? "time-value" : ""}`}
                    >
                      {report?.retention?.historical && !report.coverage.length
                        ? "待在线提取"
                        : report
                          ? key === "duration"
                            ? duration(report.totals[key])
                            : metricText(report.totals, key)
                          : "—"}
                    </div>
                    <div className="metric-foot">
                      {key === "entry_rate"
                        ? "总进房人数 ÷ 总曝光人数"
                        : key === "duration"
                          ? "当月各场时长合计"
                          : key === "sessions"
                            ? `${report?.activeDays || 0} 个开播日`
                            : "按账号、场次累计"}
                    </div>
                  </div>
                ))}
              </section>
              {!report?.retention?.historical && (
                <GuaranteeCards
                  items={report?.guarantees || []}
                  month={month}
                  isAdmin={isAdmin}
                  onEdit={(p) =>
                    setModal({
                      type: "guarantee",
                      anchor: { id: p.anchor_id, name: p.name },
                      month,
                      seconds: p.target,
                    })
                  }
                />
              )}
              <section className="analysis-band">
                <div className="trend-panel">
                  <div className="section-title">
                    <h2>每日趋势</h2>
                    <div className="segmented">
                      {[
                        ["duration", "时长"],
                        ["followers", "新增粉丝"],
                        ["gifters", "送礼人数"],
                      ].map(([k, t]) => (
                        <button
                          key={k}
                          className={metric === k ? "selected" : ""}
                          onClick={() => setMetric(k)}
                        >
                          {t}
                        </button>
                      ))}
                    </div>
                  </div>
                  {report && <Trend daily={report.daily} metric={metric} />}
                </div>
                <div className="ranking-panel">
                  <div className="section-title">
                    <h2>主播月度排行</h2>
                    <span className="muted">直播时长</span>
                  </div>
                  {report?.anchors
                    .filter((a) => a.accounts > 0)
                    .sort((a, b) => b.duration - a.duration)
                    .slice(0, 4)
                    .map((a, i) => (
                      <button
                        className="rank-row"
                        key={a.id}
                        onClick={() => {
                          setAnchor(a.id);
                          setAccount("");
                        }}
                      >
                        <span className="rank-number">
                          {String(i + 1).padStart(2, "0")}
                        </span>
                        <Avatar name={a.name} />
                        <span className="rank-name">
                          <strong>{a.name}</strong>
                          <small>{a.accounts} 个抖音号</small>
                        </span>
                        <strong className="rank-value">
                          {duration(a.duration)}
                        </strong>
                      </button>
                    ))}
                  {!report?.anchors.some((a) => a.accounts > 0) && (
                    <Empty
                      icon={Users}
                      title="暂无主播数据"
                      action={
                        <button
                          className="text-button"
                          onClick={() => navigatePage("anchors")}
                        >
                          管理主播 <ArrowUpRight size={14} />
                        </button>
                      }
                    />
                  )}
                </div>
              </section>
              <section className="records">
                <div className="records-toolbar">
                  <div className="tabs">
                    <button
                      className={view === "daily" ? "active" : ""}
                      onClick={() => setView("daily")}
                    >
                      每日统计
                    </button>
                    <button
                      className={view === "sessions" ? "active" : ""}
                      onClick={() => setView("sessions")}
                    >
                      场次明细{" "}
                      <span>
                        {report?.sessions.filter(
                          (s) => !sessionDate || s.date === sessionDate,
                        ).length || 0}
                      </span>
                    </button>
                  </div>
                  <div className="table-actions">
                    <input
                      type="date"
                      aria-label="场次日期"
                      min={report?.from}
                      max={report?.to}
                      value={sessionDate}
                      onChange={(e) => {
                        setSessionDate(e.target.value);
                        setView("sessions");
                      }}
                    />
                    {sessionDate && (
                      <button
                        className="icon-button"
                        title="查看整月场次"
                        aria-label="查看整月场次"
                        onClick={() => setSessionDate("")}
                      >
                        <X size={16} />
                      </button>
                    )}
                    <span className="coverage">
                      {report?.completeDays || 0} / {report?.elapsedDays || 0}{" "}
                      天已核对
                    </span>
                    <a
                      className="icon-button"
                      title="导出CSV"
                      aria-label="导出CSV"
                      href={exportUrl}
                    >
                      <Download size={17} />
                    </a>
                  </div>
                </div>
                <div className="table-scroll">
                  {view === "daily" ? (
                    <table>
                      <thead>
                        <tr>
                          <th>日期</th>
                          <th>直播时长</th>
                          <th>新增粉丝</th>
                          <th>送礼人数</th>
                          <th>加粉丝团人数</th>
                          <th>评论人数</th>
                          <th>曝光人数</th>
                          <th>进房人数</th>
                          <th>进房率</th>
                          <th>场次</th>
                          <th>数据状态</th>
                          <th />
                        </tr>
                      </thead>
                      <tbody>
                        {report?.daily.map((d) => (
                          <React.Fragment key={d.date}>
                            <tr
                              className={expanded.has(d.date) ? "expanded" : ""}
                            >
                              <td className="date-cell">
                                <button
                                  className="text-button"
                                  aria-label={`查看 ${d.date} 全部场次`}
                                  onClick={() => {
                                    setSessionDate(d.date);
                                    setView("sessions");
                                  }}
                                >
                                  {d.date.slice(5).replace("-", " / ")}
                                </button>
                                <small>
                                  {
                                    [
                                      "周日",
                                      "周一",
                                      "周二",
                                      "周三",
                                      "周四",
                                      "周五",
                                      "周六",
                                    ][new Date(d.date).getUTCDay()]
                                  }
                                </small>
                              </td>
                              <td className="numeric">
                                {d.state !== "complete" &&
                                !(d.state === "provisional" && d.checked > 0) &&
                                !d.sessions
                                  ? "—"
                                  : duration(d.duration)}
                              </td>
                              <td className="numeric">
                                {d.state !== "complete" &&
                                !(d.state === "provisional" && d.checked > 0) &&
                                !d.sessions
                                  ? "—"
                                  : metricText(d, "followers")}
                              </td>
                              <td className="numeric">
                                {d.state !== "complete" &&
                                !(d.state === "provisional" && d.checked > 0) &&
                                !d.sessions
                                  ? "—"
                                  : metricText(d, "gifters")}
                              </td>
                              <td className="numeric">
                                {d.checked || d.sessions
                                  ? metricText(d, "fanclub")
                                  : "—"}
                              </td>
                              <td className="numeric">
                                {d.checked || d.sessions
                                  ? metricText(d, "commenters")
                                  : "—"}
                              </td>
                              <td className="numeric">
                                {d.checked || d.sessions
                                  ? metricText(d, "exposure")
                                  : "—"}
                              </td>
                              <td className="numeric">
                                {d.checked || d.sessions
                                  ? metricText(d, "entrants")
                                  : "—"}
                              </td>
                              <td className="numeric">
                                {d.checked || d.sessions
                                  ? metricText(d, "entry_rate")
                                  : "—"}
                              </td>
                              <td>
                                {d.state !== "complete" &&
                                !(d.state === "provisional" && d.checked > 0) &&
                                !d.sessions
                                  ? "—"
                                  : d.sessions}
                              </td>
                              <td>
                                <Badge status={d.state} kind="day" />
                              </td>
                              <td>
                                <IconButton
                                  icon={ChevronRight}
                                  label={`${d.date} 场次明细`}
                                  disabled={!d.sessions}
                                  onClick={() =>
                                    setExpanded((current) => {
                                      const next = new Set(current);
                                      if (next.has(d.date)) next.delete(d.date);
                                      else next.add(d.date);
                                      return next;
                                    })
                                  }
                                />
                              </td>
                            </tr>
                            {expanded.has(d.date) && (
                              <tr className="detail-row">
                                <td colSpan={12}>
                                  <div className="day-details">
                                    {report.sessions
                                      .filter((s) => s.date === d.date)
                                      .map((s) => (
                                        <div key={s.room_id}>
                                          <span>
                                            开播时间：{s.start.slice(11)}
                                          </span>
                                          <strong>主播：{s.anchor_name}</strong>
                                          <span>
                                            直播号：
                                            {s.nickname ||
                                              s.handle ||
                                              "待扫码账号"}
                                          </span>
                                          <span>
                                            直播时长：{duration(s.duration)}
                                          </span>
                                          <span>
                                            新增 {metricText(s, "followers")}
                                          </span>
                                          <span>
                                            送礼 {metricText(s, "gifters")}
                                          </span>
                                          <span>
                                            加粉丝团 {metricText(s, "fanclub")}
                                          </span>
                                          <span>
                                            评论 {metricText(s, "commenters")}
                                          </span>
                                          <span>
                                            曝光人数：
                                            {metricText(s, "exposure")}
                                          </span>
                                          <span>
                                            进房人数：
                                            {metricText(s, "entrants")}
                                          </span>
                                          <span>
                                            进房率：
                                            {metricText(s, "entry_rate")}
                                          </span>
                                        </div>
                                      ))}
                                  </div>
                                </td>
                              </tr>
                            )}
                          </React.Fragment>
                        ))}
                      </tbody>
                      <tfoot>
                        <tr>
                          <td>当月合计</td>
                          <td>
                            <small className="block">直播时长</small>
                            {duration(report?.totals.duration)}
                          </td>
                          <td>
                            <small className="block">新增粉丝</small>
                            {metricText(report?.totals, "followers")}
                          </td>
                          <td>
                            <small className="block">送礼人数</small>
                            {metricText(report?.totals, "gifters")}
                          </td>
                          <td>
                            <small className="block">加粉丝团人数</small>
                            {metricText(report?.totals, "fanclub")}
                          </td>
                          <td>
                            <small className="block">评论人数</small>
                            {metricText(report?.totals, "commenters")}
                          </td>
                          <td>
                            <small className="block">曝光人数</small>
                            {metricText(report?.totals, "exposure")}
                          </td>
                          <td>
                            <small className="block">进房人数</small>
                            {metricText(report?.totals, "entrants")}
                          </td>
                          <td>
                            <small className="block">进房率</small>
                            {metricText(report?.totals, "entry_rate")}
                          </td>
                          <td>
                            <small className="block">直播场次</small>
                            {count(report?.totals.sessions)}
                          </td>
                          <td colSpan={2}>
                            {report?.month === report?.today.slice(0, 7)
                              ? "含今日暂计"
                              : report?.completeDays === report?.elapsedDays &&
                                  accounts.length
                                ? "已核对"
                                : "按已采集数据"}
                          </td>
                        </tr>
                      </tfoot>
                    </table>
                  ) : (
                    <table>
                      <thead>
                        <tr>
                          <th>开播时间</th>
                          <th>关播时间</th>
                          <th>主播 / 抖音号</th>
                          <th>直播时长</th>
                          <th>新增粉丝</th>
                          <th>送礼人数</th>
                          <th>加粉丝团人数</th>
                          <th>评论人数</th>
                          <th>曝光人数</th>
                          <th>进房人数</th>
                          <th>进房率</th>
                          <th>场次 ID</th>
                        </tr>
                      </thead>
                      <tbody>
                        {report?.sessions
                          .filter((s) => !sessionDate || s.date === sessionDate)
                          .map((s) => (
                            <tr key={s.room_id}>
                              <td>{s.start}</td>
                              <td>{s.end}</td>
                              <td>
                                <strong>{s.anchor_name}</strong>
                                <small className="block">
                                  {s.nickname || s.handle || "待扫码账号"}
                                </small>
                              </td>
                              <td>{duration(s.duration)}</td>
                              <td>{metricText(s, "followers")}</td>
                              <td>{metricText(s, "gifters")}</td>
                              <td>{metricText(s, "fanclub")}</td>
                              <td>{metricText(s, "commenters")}</td>
                              <td>{metricText(s, "exposure")}</td>
                              <td>{metricText(s, "entrants")}</td>
                              <td>{metricText(s, "entry_rate")}</td>
                              <td className="mono muted">{s.room_id}</td>
                            </tr>
                          ))}
                      </tbody>
                    </table>
                  )}
                </div>
                {view === "sessions" &&
                  !report?.sessions.some(
                    (s) => !sessionDate || s.date === sessionDate,
                  ) && (
                    <Empty
                      title={
                        sessionDate
                          ? "该日期暂无已采集场次"
                          : "该月份暂无场次记录"
                      }
                    />
                  )}
                <div className="records-foot">
                  <span>月度周期：1 日至月末 · 按开播日期归属</span>
                  <span>
                    本地保留数据累计：{duration(report?.allTime.duration)} /
                    新增 {metricText(report?.allTime, "followers")} / 送礼{" "}
                    {metricText(report?.allTime, "gifters")}
                    {" / 加粉丝团 "}
                    {metricText(report?.allTime, "fanclub")}
                    {" / 评论 "}
                    {metricText(report?.allTime, "commenters")}
                    {" / 曝光 "}
                    {metricText(report?.allTime, "exposure")}
                    {" / 进房 "}
                    {metricText(report?.allTime, "entrants")}
                    {" / 进房率 "}
                    {metricText(report?.allTime, "entry_rate")}
                  </span>
                </div>
              </section>
            </>
          )}
          {page === "anchors" && (
            <>
              <section className="management-toolbar">
                <div className="search">
                  <Search size={17} />
                  <input
                    aria-label="搜索主播或抖音号"
                    placeholder="搜索主播、备注、抖音号"
                    value={query}
                    onChange={(e) => setQuery(e.target.value)}
                  />
                </div>
                <span className="muted">
                  {anchors.length} 位主播 · {accounts.length} 个抖音号
                </span>
              </section>
              {anchors
                .filter((a) =>
                  [
                    a.name,
                    a.note,
                    ...accounts
                      .filter((b) => b.anchor_id === a.id)
                      .flatMap((b) => [b.handle, b.nickname, b.note]),
                  ]
                    .join(" ")
                    .toLowerCase()
                    .includes(query.toLowerCase()),
                )
                .map((a) => (
                  <section className="anchor-section" key={a.id}>
                    <header className="anchor-heading">
                      <Avatar name={a.name} />
                      <div className="anchor-info">
                        <h2>
                          {a.name}
                          <span>
                            {
                              accounts.filter((b) => b.anchor_id === a.id)
                                .length
                            }{" "}
                            个账号
                          </span>
                        </h2>
                        <p>{a.note || "未填写备注"}</p>
                        <p>
                          {a.is_leader
                            ? `组长 · ${anchors.filter((member) => member.leader_id === a.id).length} 位组员`
                            : a.leader_id
                              ? `归属组长：${anchors.find((leader) => leader.id === a.leader_id)?.name || "已分组"}`
                              : "未分组"}
                        </p>
                        {isAdmin &&
                          state?.users
                            ?.filter((u) => u.anchor_id === a.id)
                            .map((u) => (
                              <p key={u.id}>
                                登录账号：{u.username} ·{" "}
                                {u.enabled ? "已启用" : "已停用"}
                              </p>
                            ))}
                      </div>
                      {isAdmin && (
                        <IconButton
                          icon={Pencil}
                          label={`编辑主播 ${a.name}`}
                          onClick={() => anchorForm(a)}
                        />
                      )}
                      {isAdmin && (
                        <button
                          className="text-button"
                          aria-label={`删除主播 ${a.name}`}
                          title="删除主播及其名下账号；执行中的相关任务需先结束"
                          onClick={() =>
                            setModal({ type: "deleteAnchor", anchor: a })
                          }
                        >
                          <Trash2 size={16} />
                          删除主播
                        </button>
                      )}
                      {isAdmin && (
                        <button
                          className="button"
                          onClick={() =>
                            setModal({
                              type: "guarantee",
                              anchor: a,
                              month,
                              seconds: report?.guarantees?.find(
                                (p) => p.anchor_id === a.id,
                              )?.target,
                            })
                          }
                        >
                          设置保底
                        </button>
                      )}
                      {isAdmin && (
                        <button
                          className="button"
                          onClick={() => setModal({ type: "team", anchor: a })}
                        >
                          组长与归属
                        </button>
                      )}
                      {isAdmin && (
                        <button
                          className="button"
                          onClick={() =>
                            setModal({
                              type: "userAccess",
                              anchor: a,
                              user: state?.users?.find(
                                (u) => u.anchor_id === a.id,
                              ),
                            })
                          }
                        >
                          <KeyRound size={16} />
                          {state?.users?.some((u) => u.anchor_id === a.id)
                            ? "管理登录账号"
                            : "开通登录账号"}
                        </button>
                      )}
                      {(isAdmin || a.id === user.anchor_id) && (
                        <button
                          className="button"
                          onClick={() =>
                            setModal({ type: "account", initialAnchor: a.id })
                          }
                        >
                          <Plus size={16} />
                          添加抖音号
                        </button>
                      )}
                    </header>
                    <div className="table-scroll">
                      <table className="account-table">
                        <thead>
                          <tr>
                            <th>抖音账号</th>
                            <th>账号备注</th>
                            <th>账号状态</th>
                            <th>最近登录检测</th>
                            <th>最近成功同步</th>
                            <th>操作</th>
                          </tr>
                        </thead>
                        <tbody>
                          {accounts
                            .filter((b) => b.anchor_id === a.id)
                            .map((b) => (
                              <tr key={b.id}>
                                <td>
                                  <strong>
                                    {b.nickname || b.note || "待扫码账号"}
                                  </strong>
                                  {b.douyin_handle && (
                                    <small className="block">
                                      抖音号：{b.douyin_handle}
                                    </small>
                                  )}
                                  {!b.enabled && (
                                    <small className="block">已暂停</small>
                                  )}
                                </td>
                                <td className="note-cell">{b.note || "—"}</td>
                                <td>
                                  <Badge status={b.status} />
                                  {b.error && (
                                    <small className="block error-text">
                                      {b.error}
                                    </small>
                                  )}
                                </td>
                                <td className="login-check-cell">
                                  {checking === b.id ? (
                                    <span className="muted">正在检测…</span>
                                  ) : b.login_checks?.length ? (
                                    <>
                                      <Badge
                                        status={b.login_checks[0].result}
                                        kind="loginCheck"
                                      />
                                      <small className="block">
                                        {localTime(
                                          b.login_checks[0].checked_at,
                                        )}
                                      </small>
                                      <button
                                        className="text-button"
                                        onClick={() =>
                                          setModal({
                                            type: "loginChecks",
                                            account: b,
                                          })
                                        }
                                      >
                                        <History size={14} />
                                        检测记录
                                      </button>
                                    </>
                                  ) : (
                                    <span className="muted">尚未检测</span>
                                  )}
                                </td>
                                <td className="muted">
                                  {localTime(b.last_sync)}
                                </td>
                                <td>
                                  {isAdmin || b.anchor_id === user.anchor_id ? (
                                    <div className="row-actions">
                                      <button
                                        className="text-button"
                                        aria-label={`同步账号 ${b.nickname || b.handle || "待扫码账号"}`}
                                        title="检测登录后，从当月1号补齐缺失数据；已核对的历史日期跳过"
                                        disabled={
                                          pendingSync === b.id ||
                                          !b.enabled ||
                                          [
                                            "unbound",
                                            "binding",
                                            "expired",
                                            "verification",
                                            "mismatch",
                                            "syncing",
                                          ].includes(b.status) ||
                                          state?.jobs?.some(
                                            (j) =>
                                              j.account_id === b.id &&
                                              j.kind === "sync" &&
                                              ["queued", "running"].includes(
                                                j.status,
                                              ),
                                          )
                                        }
                                        onClick={() => syncAccount(b)}
                                      >
                                        <RefreshCw size={16} />
                                        {b.status === "syncing"
                                          ? "同步中"
                                          : pendingSync === b.id ||
                                              state?.jobs?.some(
                                                (j) =>
                                                  j.account_id === b.id &&
                                                  j.kind === "sync" &&
                                                  [
                                                    "queued",
                                                    "running",
                                                  ].includes(j.status),
                                              )
                                            ? "已排队"
                                            : b.status === "error"
                                              ? "重试同步"
                                              : "同步"}
                                      </button>
                                      <button
                                        className="text-button"
                                        disabled={Boolean(
                                          pendingCheck === b.id,
                                        )}
                                        onClick={() => checkAccount(b)}
                                      >
                                        {checking === b.id ? (
                                          <Loader2 size={16} className="spin" />
                                        ) : (
                                          <ShieldCheck size={16} />
                                        )}
                                        {checking === b.id
                                          ? "检测中"
                                          : "检测登录状态"}
                                      </button>
                                      <button
                                        className="text-button"
                                        onClick={() => login(b)}
                                      >
                                        <ScanLine size={16} />
                                        {b.status === "unbound"
                                          ? "扫码绑定"
                                          : "重新登录"}
                                      </button>
                                      {isAdmin && (
                                        <button
                                          className="text-button"
                                          aria-label={`导出 Cookie ${b.nickname || b.douyin_handle || b.note || "待扫码账号"}`}
                                          title="下载此账号的 Cookie-Editor JSON 文件"
                                          disabled={
                                            Boolean(pendingExport) ||
                                            b.status === "unbound"
                                          }
                                          onClick={() => exportCookies(b)}
                                        >
                                          {pendingExport === b.id ? (
                                            <Loader2
                                              size={16}
                                              className="spin"
                                            />
                                          ) : (
                                            <Download size={16} />
                                          )}
                                          {pendingExport === b.id
                                            ? "导出中…"
                                            : "导出 Cookie"}
                                        </button>
                                      )}
                                      <IconButton
                                        icon={Pencil}
                                        label={`编辑账号 ${b.handle}`}
                                        disabled={Boolean(busy)}
                                        onClick={() =>
                                          setModal({
                                            type: "account",
                                            account: b,
                                          })
                                        }
                                      />
                                      <button
                                        className="text-button"
                                        aria-label={`删除抖音号 ${b.handle || b.nickname || "待扫码账号"}`}
                                        disabled={
                                          checking === b.id ||
                                          (state?.sync?.busy &&
                                            (!state.sync.progress?.accountId ||
                                              state.sync.progress.accountId ===
                                                b.id)) ||
                                          b.status === "binding"
                                        }
                                        onClick={() =>
                                          setModal({
                                            type: "deleteAccount",
                                            account: b,
                                          })
                                        }
                                      >
                                        <Trash2 size={16} />
                                        删除
                                      </button>
                                    </div>
                                  ) : (
                                    <span className="muted">仅查看数据</span>
                                  )}
                                </td>
                              </tr>
                            ))}
                        </tbody>
                      </table>
                    </div>
                    {!accounts.some((b) => b.anchor_id === a.id) && (
                      <Empty icon={Link2} title="尚未关联抖音号" />
                    )}
                  </section>
                ))}
              {!anchors.length && (
                <Empty
                  icon={Users}
                  title="暂无主播"
                  action={
                    <button
                      className="button primary"
                      onClick={() => anchorForm()}
                    >
                      <Plus size={16} />
                      添加主播
                    </button>
                  }
                />
              )}
            </>
          )}
          {page === "logs" && (
            <section className="records">
              <div className="section-title">
                <h2>最近同步任务</h2>
                <IconButton
                  icon={RefreshCw}
                  label="刷新同步记录"
                  onClick={refresh}
                />
              </div>
              <div className="table-scroll">
                <table>
                  <thead>
                    <tr>
                      <th>开始时间</th>
                      <th>主播 / 抖音号</th>
                      <th>采集日期</th>
                      <th>状态</th>
                      <th>场次</th>
                      <th>结果</th>
                    </tr>
                  </thead>
                  <tbody>
                    {runData.items.map((r) => (
                      <tr key={r.id}>
                        <td>
                          {localTime(r.started_at)}
                          <small className="block">
                            {r.source === "scheduled"
                              ? "每日定时"
                              : r.source === "realtime"
                                ? "实时更新"
                                : "手动同步"}
                          </small>
                        </td>
                        <td>
                          <strong>{r.anchor_name}</strong>
                          <small className="block">
                            {r.nickname || r.handle || "待扫码账号"}
                          </small>
                        </td>
                        <td>
                          {r.from_date}
                          <small className="block">至 {r.to_date}</small>
                        </td>
                        <td>
                          <span
                            className={`badge ${r.status === "success" ? "green" : r.status === "error" ? "red" : "amber"}`}
                          >
                            <i />
                            {r.status === "success"
                              ? "已完成"
                              : r.status === "error"
                                ? "失败"
                                : "进行中"}
                          </span>
                        </td>
                        <td>{r.session_count}</td>
                        <td className="note-cell">{r.message || "采集中"}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              <div className="records-foot">
                <IconButton
                  icon={ChevronLeft}
                  label="上一页同步记录"
                  disabled={runPage === 1}
                  onClick={() => setRunPage((p) => p - 1)}
                />
                <span>
                  第 {runPage} 页 · 每页15条 · 共 {runData.total} 条
                </span>
                <IconButton
                  icon={ChevronRight}
                  label="下一页同步记录"
                  disabled={runPage * 15 >= runData.total}
                  onClick={() => setRunPage((p) => p + 1)}
                />
              </div>
              {!runData.items.length && (
                <Empty icon={History} title="暂无同步记录" />
              )}
            </section>
          )}
          {["jobs", "notices", "audits", "backups"].includes(page) &&
            (isAdmin || !["audits", "backups"].includes(page)) && (
              <Operations
                key={page}
                view={page}
                isAdmin={isAdmin}
                onRefresh={refresh}
              />
            )}
          {isAdmin && page === "settings" && state && (
            <ScheduleForm
              initial={state.schedule}
              onSave={async (v) => {
                try {
                  await send("/api/schedule", "PATCH", v);
                  await refresh();
                  notify("同步设置已保存");
                } catch (e) {
                  notify(e.message, "error");
                }
              }}
            />
          )}
          <footer className="page-footer">
            <span>主播数据管理器 · 主播数据统计</span>
            <span>
              {state?.schedule.enabled
                ? state.schedule.realtimeEnabled
                  ? `每 ${state.schedule.intervalMinutes >= 60 ? `${state.schedule.intervalMinutes / 60} 小时` : `${state.schedule.intervalMinutes} 分钟`}更新 · 每日 ${state.schedule.time} 核对`
                  : `每日 ${state.schedule.time} 自动同步`
                : "自动同步已暂停"}
            </span>
          </footer>
        </main>
      </div>
      {toast && (
        <div
          role="status"
          className={`toast ${toast.type === "error" ? "error" : ""}`}
        >
          {toast.type === "error" ? (
            <AlertCircle size={18} />
          ) : (
            <CheckCircle2 size={18} />
          )}
          <span>{toast.text}</span>
          <IconButton
            icon={X}
            label="关闭通知"
            onClick={() => setToast(null)}
          />
        </div>
      )}
      {isAdmin && modal?.type === "userAccess" && (
        <UserAccessForm
          Modal={Modal}
          anchor={modal.anchor}
          user={modal.user}
          onClose={() => setModal(null)}
          onSave={refresh}
        />
      )}
      {isAdmin && modal?.type === "guarantee" && (
        <GuaranteeForm
          anchor={modal.anchor}
          initialMonth={modal.month}
          initialSeconds={modal.seconds}
          Modal={Modal}
          onClose={() => setModal(null)}
          onSave={refresh}
        />
      )}
      {modal?.type === "deleteAccount" &&
        (isAdmin || modal.account.anchor_id === user.anchor_id) && (
          <DeleteAccount
            account={modal.account}
            onClose={() => setModal(null)}
            onSave={async () => {
              setAccount("");
              await refresh();
            }}
          />
        )}
      {isAdmin && modal?.type === "deleteAnchor" && (
        <DeleteAnchor
          anchor={modal.anchor}
          accounts={accounts.filter((a) => a.anchor_id === modal.anchor.id)}
          members={
            anchors.filter((a) => a.leader_id === modal.anchor.id).length
          }
          onClose={() => setModal(null)}
          onSave={async (result) => {
            if (anchorId === modal.anchor.id) setAnchor("");
            if (
              accounts.some(
                (a) => a.id === accountId && a.anchor_id === modal.anchor.id,
              )
            )
              setAccount("");
            await refresh();
            notify(
              result.cleanupPending
                ? "主播已删除，部分登录环境文件需管理员清理，请查看服务器日志"
                : "主播已删除",
              result.cleanupPending ? "error" : "success",
            );
          }}
        />
      )}
      {modal?.type === "password" && (
        <PasswordForm
          Modal={Modal}
          onClose={() => setModal(null)}
          onSave={onLogout}
        />
      )}
      {isAdmin && modal?.type === "anchor" && (
        <AnchorForm
          anchor={modal.anchor}
          onClose={() => setModal(null)}
          onSave={refresh}
        />
      )}{" "}
      {isAdmin && modal?.type === "team" && (
        <TeamForm
          anchor={modal.anchor}
          anchors={anchors}
          onClose={() => setModal(null)}
          onSave={refresh}
        />
      )}
      {modal?.type === "account" && (
        <AccountForm
          isAdmin={isAdmin}
          account={modal.account}
          initialAnchor={modal.initialAnchor}
          anchors={anchors.filter((a) => isAdmin || a.id === user.anchor_id)}
          onClose={() => setModal(null)}
          onSave={refresh}
          onLogin={login}
        />
      )}{" "}
      {modal?.type === "login" && (
        <LoginModal
          account={modal.account}
          onClose={() => setModal(null)}
          onSave={refresh}
        />
      )}{" "}
      {modal?.type === "loginChecks" && (
        <Modal
          title={`${modal.account.nickname || modal.account.handle} · 登录检测记录`}
          onClose={() => setModal(null)}
        >
          <div className="login-check-history">
            {(
              accounts.find((a) => a.id === modal.account.id)?.login_checks ||
              []
            ).map((record) => (
              <div key={record.id}>
                <Badge status={record.result} kind="loginCheck" />
                <time>{localTime(record.checked_at)}</time>
                <p>{record.message}</p>
              </div>
            ))}
          </div>
        </Modal>
      )}
      {modal?.type === "backfill" && (
        <Backfill
          accounts={ownAccounts}
          month={month}
          onClose={() => setModal(null)}
          onSave={refresh}
        />
      )}
    </div>
  );
}
function ScheduleForm({ initial, onSave }) {
  const [enabled, setEnabled] = useState(initial.enabled),
    [time, setTime] = useState(initial.time),
    [realtimeEnabled, setRealtimeEnabled] = useState(initial.realtimeEnabled),
    [intervalMinutes, setIntervalMinutes] = useState(initial.intervalMinutes),
    [busy, setBusy] = useState(false);
  return (
    <form
      className="settings-form"
      onSubmit={async (e) => {
        e.preventDefault();
        setBusy(true);
        await onSave({
          enabled,
          time,
          lookback: initial.lookback || 3,
          realtimeEnabled,
          intervalMinutes,
        });
        setBusy(false);
      }}
    >
      <section className="setting-section">
        <h2>自动同步</h2>
        <div className="setting-row">
          <label htmlFor="auto-sync">启用自动采集</label>
          <input
            className="toggle"
            id="auto-sync"
            type="checkbox"
            checked={enabled}
            onChange={(e) => setEnabled(e.target.checked)}
          />
        </div>
        <div className="setting-row">
          <label htmlFor="realtime-sync">定期更新</label>
          <input
            id="realtime-sync"
            className="toggle"
            type="checkbox"
            checked={realtimeEnabled}
            onChange={(e) => setRealtimeEnabled(e.target.checked)}
          />
        </div>
        <div className="setting-row">
          <label htmlFor="sync-interval">更新间隔</label>
          <select
            id="sync-interval"
            value={intervalMinutes}
            onChange={(e) => setIntervalMinutes(Number(e.target.value))}
          >
            {[1, 3, 5, 10, 15, 30, 60, 180, 360, 720].map((n) => (
              <option key={n} value={n}>
                {n >= 60 ? `${n / 60} 小时` : `${n} 分钟`}
              </option>
            ))}
          </select>
        </div>
        <div className="setting-row">
          <label htmlFor="sync-time">执行时间（北京时间）</label>
          <input
            id="sync-time"
            type="time"
            required
            value={time}
            onChange={(e) => setTime(e.target.value)}
          />
        </div>
        <p className="muted">
          登录网页不会触发采集。定期更新和“立即同步”补齐当月缺失、未完成核对的数据，已完整核对的历史日期跳过，当天继续更新。每日补采继续核对保留范围内的历史遗漏。每次采集会检测登录；临时失败最多重试两次，分别等待1分钟、5分钟。需强制重新提取旧数据时使用“补采数据”。
        </p>
      </section>
      <section className="setting-section">
        <h2>统计口径</h2>
        <dl>
          <div>
            <dt>统计周期</dt>
            <dd>自然月，每月 1 日至最后一天</dd>
          </div>
          <div>
            <dt>场次日期</dt>
            <dd>北京时间，按开播日期归属</dd>
          </div>
          <div>
            <dt>直播时长</dt>
            <dd>各场秒数相加；跨账号同时开播也累计</dd>
          </div>
          <div>
            <dt>新增粉丝 / 送礼人数</dt>
            <dd>按账号、场次累计，不跨场去重</dd>
          </div>
          <div>
            <dt>运行状态</dt>
            <dd>服务在线时执行；重启后补跑当天错过的任务</dd>
          </div>
        </dl>
      </section>
      <button className="button primary" disabled={busy}>
        <Check size={16} />
        保存设置
      </button>
    </form>
  );
}
function DeleteAnchor({ anchor, accounts, members, onClose, onSave }) {
  const [confirmation, setConfirmation] = useState(""),
    [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  return (
    <Modal
      title={`删除主播 · ${anchor.name}`}
      onClose={() => {
        if (!busy) onClose();
      }}
    >
      <form
        onSubmit={async (e) => {
          e.preventDefault();
          setBusy(true);
          setError("");
          try {
            const result = await send(`/api/anchors/${anchor.id}`, "DELETE", {
              confirmation,
            });
            await onSave(result);
            onClose();
          } catch (e) {
            setError(e.message);
          } finally {
            setBusy(false);
          }
        }}
      >
        <p>
          将删除主播“{anchor.name}”、其网站登录账号、保底设置及名下{" "}
          {accounts.length}{" "}
          个抖音号的登录环境和直播数据。删除前会自动备份数据库。
        </p>
        {accounts.length > 0 && (
          <p>
            涉及抖音号：
            {accounts
              .map((a) => a.nickname || a.handle || "待扫码账号")
              .join("、")}
          </p>
        )}
        {members > 0 && (
          <p>
            该主播是组长，其 {members} 位组员将解除归属；组员账号和数据保留。
          </p>
        )}
        <label>
          输入“确认删除”
          <input
            autoComplete="off"
            placeholder="确认删除"
            required
            value={confirmation}
            onChange={(e) => setConfirmation(e.target.value)}
          />
        </label>
        {error && <p className="form-error">{error}</p>}
        <footer>
          <button
            type="button"
            className="button"
            onClick={onClose}
            disabled={busy}
          >
            取消
          </button>
          <button
            className="button danger"
            disabled={busy || confirmation !== "确认删除"}
          >
            <Trash2 size={16} />
            确认删除
          </button>
        </footer>
      </form>
    </Modal>
  );
}
function DeleteAccount({ account, onClose, onSave }) {
  const [confirmation, setConfirmation] = useState(""),
    [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  return (
    <Modal
      title="删除抖音号"
      onClose={() => {
        if (!busy) onClose();
      }}
    >
      <form
        onSubmit={async (e) => {
          e.preventDefault();
          setBusy(true);
          setError("");
          try {
            await send(`/api/accounts/${account.id}`, "DELETE", {
              confirmation,
            });
            await onSave();
            onClose();
          } catch (e) {
            setError(e.message);
          } finally {
            setBusy(false);
          }
        }}
      >
        <p>
          将删除 {account.nickname || account.note || "待扫码账号"}{" "}
          的登录环境、历史直播数据和同步记录，主播合计也会减少。删除前会自动备份数据库。
        </p>
        <label>
          输入“确认删除”
          <input
            value={confirmation}
            onChange={(e) => setConfirmation(e.target.value)}
            placeholder="确认删除"
            autoComplete="off"
            required
          />
        </label>
        {error && <p className="form-error">{error}</p>}
        <footer>
          <button
            className="button"
            type="button"
            disabled={busy}
            onClick={onClose}
          >
            取消
          </button>
          <button
            className="button danger"
            disabled={busy || confirmation !== "确认删除"}
          >
            <Trash2 size={16} />
            确认删除
          </button>
        </footer>
      </form>
    </Modal>
  );
}

createRoot(document.getElementById("root")).render(
  <AuthGate>
    {(user, onLogout) => <App key={user.id} user={user} onLogout={onLogout} />}
  </AuthGate>,
);
