import React, { useState, useEffect, useRef } from "react";
import {
  RefreshCw,
  Check,
  X,
  Download,
  Database,
  ChevronLeft,
  ChevronRight,
  Send,
  ArrowDown,
  ArrowUp,
  CornerDownLeft,
  Delete,
} from "lucide-react";
async function call(url, method = "GET", data) {
  const r = await fetch(url, {
    method,
    headers: { "Content-Type": "application/json" },
    body: data === undefined ? undefined : JSON.stringify(data),
  });
  if (r.status === 401) window.dispatchEvent(new Event("auth-expired"));
  const body = await r.json();
  if (!r.ok) throw new Error(body.error || "操作失败");
  return body;
}
const time = (s) =>
  s
    ? new Date(s).toLocaleString("zh-CN", {
        timeZone: "Asia/Shanghai",
        hour12: false,
      })
    : "";
export function Operations({ view, isAdmin, onRefresh }) {
  const [data, setData] = useState([]),
    [error, setError] = useState(""),
    [success, setSuccess] = useState(""),
    [page, setPage] = useState(1),
    [total, setTotal] = useState(0),
    [busy, setBusy] = useState(false);
  const ref = useRef(page);
  ref.current = page;
  async function load() {
    try {
      const r = await call(`/api/${view}?page=${ref.current}`);
      const total = r.total ?? r.length;
      const last = Math.max(1, Math.ceil(total / 15));
      if (ref.current > last) {
        setPage(last);
        return;
      }
      setData(r.items || r.slice((ref.current - 1) * 15, ref.current * 15));
      setTotal(total);
      setError("");
    } catch (e) {
      setError(e.message);
    }
  }
  useEffect(() => {
    load();
    const t = setInterval(load, 5000);
    return () => clearInterval(t);
  }, [view, page]);
  async function action(url, method = "POST") {
    setBusy(true);
    setSuccess("");
    try {
      const r = await call(url, method, {});
      await load();
      await onRefresh();
      if (r.ok && r.counts)
        setSuccess("校验通过：" + r.counts.sessions + " 场直播");
    } catch (e) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  }
  const labels = {
    queued: "等待中",
    running: "处理中",
    success: "已完成",
    error: "失败",
    cancelled: "已取消",
  };
  return (
    <section className="records">
      <div className="section-title">
        <h2>
          {
            {
              jobs: "任务队列",
              notices: "通知中心",
              audits: "操作记录",
              backups: "数据备份",
            }[view]
          }
        </h2>
        <div className="row-actions">
          {view === "backups" && isAdmin && (
            <button
              className="button"
              disabled={busy}
              onClick={() => action("/api/backups")}
            >
              <Database size={16} />
              立即备份
            </button>
          )}
          <button
            className="icon-button"
            title="刷新"
            aria-label="刷新"
            onClick={load}
          >
            <RefreshCw size={16} />
          </button>
        </div>
      </div>
      {view === "jobs" && (
        <p className="muted">
          这里只显示等待中和正在执行的任务；采集结果请查看同步记录。
        </p>
      )}
      {view === "notices" && (
        <p className="muted">月末最后7天，未达到直播保底时每天提醒一次。</p>
      )}
      {view === "audits" && <p className="muted">仅保留最近7天的操作记录。</p>}
      {error && (
        <p className="form-error" role="status">
          {error}
        </p>
      )}
      {success && (
        <p className="form-success" role="status">
          {success}
        </p>
      )}
      <div className="table-scroll">
        <table>
          <thead>
            <tr>
              {(view === "jobs"
                ? ["账号", "任务", "状态", "结果", "提交时间", "操作"]
                : view === "notices"
                  ? ["主播", "状态", "内容", "更新时间", "操作"]
                  : view === "audits"
                    ? ["操作人", "操作", "详情", "时间"]
                    : ["备份文件", "大小", "时间", "操作"]
              ).map((t) => (
                <th key={t}>{t}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {data.map((r) => (
              <tr key={r.id || r.name}>
                {view === "jobs" ? (
                  <>
                    <td>{r.nickname || r.handle || "待扫码账号"}</td>
                    <td>
                      {
                        {
                          sync: "同步数据",
                          check: "检测登录",
                          login: "扫码登录",
                        }[r.kind]
                      }
                    </td>
                    <td>{labels[r.status]}</td>
                    <td className="note-cell">{r.message || "等待处理"}</td>
                    <td>{time(r.created_at)}</td>
                    <td>
                      {r.status === "queued" && (
                        <button
                          className="text-button"
                          onClick={() => action(`/api/jobs/${r.id}`, "DELETE")}
                        >
                          <X size={16} />
                          取消
                        </button>
                      )}
                    </td>
                  </>
                ) : view === "notices" ? (
                  <>
                    <td>{r.anchor_name || r.nickname || r.handle || "系统"}</td>
                    <td>
                      {r.resolved ? "已恢复" : "待处理"}
                      {!r.is_read ? " · 未读" : ""}
                    </td>
                    <td className="note-cell">{r.message}</td>
                    <td>{time(r.updated_at)}</td>
                    <td>
                      {!r.is_read && (
                        <button
                          className="text-button"
                          onClick={() => action(`/api/notices/${r.id}/read`)}
                        >
                          <Check size={16} />
                          标记已读
                        </button>
                      )}
                    </td>
                  </>
                ) : view === "audits" ? (
                  <>
                    <td>{r.actor}</td>
                    <td>{r.action}</td>
                    <td className="note-cell">
                      {Object.entries(JSON.parse(r.details))
                        .map(
                          ([k, v]) =>
                            `${{ username: "登录账号", enabled: "启用", passwordReset: "重置密码", fromAnchor: "原归属", toAnchor: "新归属", trackingFrom: "统计起始日", handle: "抖音号", nickname: "昵称", reason: "原因", approval: "审核状态", name: "文件" }[k] || k}：${typeof v === "boolean" ? (v ? "是" : "否") : v}`,
                        )
                        .join("；")}
                    </td>
                    <td>{time(r.created_at)}</td>
                  </>
                ) : (
                  <>
                    <td className="note-cell">{r.name}</td>
                    <td>{(r.bytes / 1024).toFixed(0)} KB</td>
                    <td>{time(r.created_at)}</td>
                    <td>
                      <div className="row-actions">
                        <button
                          className="text-button"
                          disabled={busy}
                          onClick={() =>
                            action(`/api/backups/${r.name}/verify`)
                          }
                        >
                          <Check size={16} />
                          校验
                        </button>
                        <a
                          className="text-button"
                          href={`/api/backups/${r.name}/download`}
                        >
                          <Download size={16} />
                          下载
                        </a>
                        <a
                          className="text-button"
                          href={`/api/backups/${r.name}/manifest`}
                        >
                          校验文件
                        </a>
                        <button
                          className="text-button danger-text"
                          disabled={busy}
                          onClick={() => {
                            if (
                              window.confirm(
                                `确定删除备份 ${r.name}？删除后只能通过其他备份恢复。`,
                              )
                            )
                              action(`/api/backups/${r.name}`, "DELETE");
                          }}
                        >
                          <X size={16} />
                          删除
                        </button>
                      </div>
                    </td>
                  </>
                )}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {!data.length && <div className="empty">暂无记录</div>}
      {
        <div className="records-foot">
          <button
            className="icon-button"
            aria-label="上一页"
            disabled={page === 1}
            onClick={() => setPage((p) => p - 1)}
          >
            <ChevronLeft size={16} />
          </button>
          <span>
            第 {page} 页 · 每页 15 条 · 共 {total} 条
          </span>
          <button
            className="icon-button"
            aria-label="下一页"
            disabled={page * 15 >= total}
            onClick={() => setPage((p) => p + 1)}
          >
            <ChevronRight size={16} />
          </button>
        </div>
      }
    </section>
  );
}
export function Verification({ account, onClose, onStatus, inline = false }) {
  const [tick, setTick] = useState(0),
    [error, setError] = useState(""),
    [text, setText] = useState(""),
    [busy, setBusy] = useState(false),
    [ready, setReady] = useState(false);
  const [frame, setFrame] = useState(null);
  const [official, setOfficial] = useState(false);
  const sms = frame?.sms,
    face = frame?.face;
  useEffect(() => {
    if (face?.stage === "qr") {
      setOfficial(false);
      setText("");
    }
  }, [face?.stage]);
  const start = useRef(null);
  const statusHandler = useRef(onStatus);
  statusHandler.current = onStatus;
  useEffect(() => {
    let disposed = false;
    let timer;
    async function refreshFrame() {
      try {
        if (start.current) return;
        const r = await call(`/api/accounts/${account.id}/login`);
        if (!disposed) {
          if (
            ["ready", "finishing", "mismatch"].includes(r.phase) &&
            statusHandler.current
          ) {
            setFrame(null);
            await statusHandler.current(r);
            return;
          }
          setReady(r.phase === "ready");
          if (r.phase !== "ready") {
            const next = await call(
              `/api/accounts/${account.id}/verification/frame`,
            );
            if (!disposed && !start.current) {
              if (next.phase && statusHandler.current) {
                setFrame(null);
                await statusHandler.current(next);
                return;
              }
              setFrame(next);
            }
          }
        }
      } catch (e) {
        if (!disposed) setError(e.message);
      } finally {
        if (!disposed) timer = setTimeout(refreshFrame, 1500);
      }
    }
    refreshFrame();
    return () => {
      disposed = true;
      clearTimeout(timer);
    };
  }, [account.id, tick]);
  async function input(data) {
    if (busy) return;
    setBusy(true);
    try {
      await call(
        `/api/accounts/${account.id}/verification/input`,
        "POST",
        data,
      );
      setText("");
      setTick(Date.now());
      setError("");
    } catch (e) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  }
  function position(e, currentFrame = frame) {
    const r = e.currentTarget.getBoundingClientRect();
    return {
      x: Math.min(
        currentFrame.width - 1,
        Math.max(0, ((e.clientX - r.left) / r.width) * currentFrame.width),
      ),
      y: Math.min(
        currentFrame.height - 1,
        Math.max(0, ((e.clientY - r.top) / r.height) * currentFrame.height),
      ),
    };
  }
  return (
    <div
      className={inline ? "verification-inline" : "verification-screen"}
      role={inline ? undefined : "dialog"}
      aria-modal={inline ? undefined : "true"}
      aria-label="抖音官方验证"
    >
      <header>
        <strong>
          抖音官方登录 ·{" "}
          {account.nickname || account.douyin_handle || "待扫码账号"}
        </strong>
        <button
          className={inline ? "text-button" : "icon-button"}
          aria-label="关闭验证"
          title="关闭验证"
          onClick={onClose}
        >
          {inline ? "返回扫码" : <X size={18} />}
        </button>
      </header>
      {error && <p className="form-error">{error}</p>}
      {face?.stage === "qr" && !official ? (
        <p className="muted verification-help">
          用抖音 App
          扫描下方官方二维码，在手机上完成刷脸。完成后会自动保存登录状态并关闭弹窗。
        </p>
      ) : sms && !official ? (
        <p className="muted verification-help">
          {face?.stage === "choose"
            ? "请选择短信验证或手机刷脸验证，完成任意一种即可。"
            : "直接在这里获取并输入短信验证码，点击“验证登录”即可。"}
        </p>
      ) : (
        <p className="muted verification-help">
          在下方官方界面选择“接收短信验证码”。点击验证码输入框后，在底部输入收到的验证码，再点“填入验证码”和“确认”；如要求刷脸，请按官方提示在手机完成。
        </p>
      )}
      {ready ? (
        <div className="empty">
          <Check size={32} />
          登录完成
          <button className="button" onClick={onClose}>
            返回
          </button>
        </div>
      ) : face?.stage === "qr" && !official ? (
        <section className="face-verification" aria-label="手机刷脸验证">
          <h3>手机刷脸验证</h3>
          {face.expired && (
            <p className="form-error" role="status">
              二维码已过期，请刷新后重新扫码。
            </p>
          )}
          <img
            className="face-verification-image"
            alt="抖音官方刷脸二维码"
            src={frame.image}
          />
          <p className="muted" role="status">
            等待手机验证完成…
          </p>
          <div className="sms-actions">
            <button
              type="button"
              className="button"
              disabled={busy || !face.canRefresh}
              onClick={() => input({ type: "face-refresh" })}
            >
              <RefreshCw size={16} />
              刷新二维码
            </button>
            {face.canBack && (
              <button
                type="button"
                className="button"
                disabled={busy}
                onClick={() => input({ type: "face-back" })}
              >
                返回验证方式
              </button>
            )}
          </div>
          <button
            type="button"
            className="text-button"
            onClick={() => setOfficial(true)}
          >
            使用官方界面 / 其他验证方式
          </button>
        </section>
      ) : sms && !official ? (
        <form
          className="sms-verification"
          onSubmit={(e) => {
            e.preventDefault();
            input({ type: "sms-submit", code: text });
          }}
        >
          <h3>短信验证</h3>
          <p className="muted">
            {sms.stage === "choose"
              ? "验证码将发送到此抖音账号绑定的手机号。"
              : sms.phone
                ? `验证码发送至 ${sms.phone}`
                : "请查看此抖音账号绑定手机收到的验证码。"}
          </p>
          {sms.message && (
            <p className="form-error" role="status">
              {sms.message}
            </p>
          )}
          {sms.stage === "code" && (
            <label>
              短信验证码
              <input
                aria-label="短信验证码"
                placeholder="请输入6位验证码"
                autoComplete="one-time-code"
                inputMode="numeric"
                maxLength={6}
                value={text}
                onChange={(e) =>
                  setText(e.target.value.replace(/\D/g, "").slice(0, 6))
                }
              />
            </label>
          )}
          <div className="sms-actions">
            <button
              className="button"
              type="button"
              disabled={busy || !sms.canRequest}
              onClick={() => input({ type: "sms-request" })}
            >
              {sms.seconds > 0
                ? `${sms.seconds}秒后重新获取`
                : sms.stage === "choose"
                  ? "获取验证码"
                  : "重新获取验证码"}
            </button>
            {sms.stage === "code" && (
              <button
                className="button primary"
                disabled={busy || !/^\d{6}$/.test(text)}
              >
                {busy ? "正在处理…" : "验证登录"}
              </button>
            )}
          </div>
          {face?.stage === "choose" && (
            <div className="face-choice">
              <h3>手机刷脸验证</h3>
              <p className="muted">
                也可以用抖音 App 扫码，在手机上完成刷脸验证。
              </p>
              <button
                className="button"
                type="button"
                disabled={busy || !face.available}
                onClick={() => input({ type: "face-select" })}
              >
                使用手机刷脸验证
              </button>
            </div>
          )}
          <button
            className="text-button"
            type="button"
            onClick={() => setOfficial(true)}
          >
            使用官方界面 / 其他验证方式
          </button>
        </form>
      ) : (
        <>
          {face?.stage === "choose" && (
            <button
              className="button"
              disabled={busy || !face.available}
              onClick={() => input({ type: "face-select" })}
            >
              使用手机刷脸验证
            </button>
          )}
          {sms && (
            <button className="text-button" onClick={() => setOfficial(false)}>
              返回简洁短信验证
            </button>
          )}
          <div className="verification-viewport">
            {frame ? (
              <img
                draggable={false}
                alt="抖音官方登录验证页面"
                src={frame.image}
                style={{ aspectRatio: `${frame.width}/${frame.height}` }}
                onPointerDown={(e) => {
                  e.currentTarget.setPointerCapture(e.pointerId);
                  start.current = { point: position(e), frame };
                }}
                onPointerCancel={() => {
                  start.current = null;
                }}
                onPointerUp={(e) => {
                  if (start.current)
                    input({
                      type: "pointer",
                      from: start.current.point,
                      to: position(e, start.current.frame),
                      frameId: start.current.frame.frameId,
                    });
                  start.current = null;
                }}
              />
            ) : (
              <p className="muted">正在加载官方验证界面…</p>
            )}
          </div>
          <form
            className="verification-toolbar"
            onSubmit={(e) => {
              e.preventDefault();
              input({ type: "text", text });
            }}
          >
            <input
              aria-label="验证输入内容"
              placeholder="输入收到的验证码"
              autoComplete="one-time-code"
              inputMode="numeric"
              type="text"
              maxLength={128}
              value={text}
              onChange={(e) => setText(e.target.value)}
            />
            <button
              className="button"
              title="输入到已选中的官方输入框"
              aria-label="输入验证码"
              disabled={busy || !text}
            >
              <Send size={17} />
              填入验证码
            </button>
            {[
              ["Control+A", "全选", Check],
              ["Backspace", "删除", Delete],
              ["Enter", "确认", CornerDownLeft],
            ].map(([key, label, Icon]) => (
              <button
                type="button"
                key={key}
                className={key === "Enter" ? "button" : "icon-button"}
                title={label}
                aria-label={label}
                disabled={busy}
                onClick={() => input({ type: "key", key })}
              >
                <Icon size={17} />
                {key === "Enter" ? "确认" : ""}
              </button>
            ))}
            {[
              [-500, ArrowUp, "向上滚动"],
              [500, ArrowDown, "向下滚动"],
            ].map(([delta, Icon, label]) => (
              <button
                key={delta}
                type="button"
                className="icon-button"
                title={label}
                aria-label={label}
                onClick={() => input({ type: "scroll", delta })}
              >
                <Icon size={17} />
              </button>
            ))}
          </form>
        </>
      )}
    </div>
  );
}
