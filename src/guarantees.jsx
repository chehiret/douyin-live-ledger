import React, { useState, useEffect } from "react";
import { Check, Target } from "lucide-react";
const duration = (s) =>
  `${Math.floor(s / 3600)}时${Math.floor((s % 3600) / 60)}分${s % 60}秒`;
export function GuaranteeCards({ items, month, isAdmin, onEdit }) {
  return (
    <section className="guarantee-section">
      <div className="section-title">
        <h2>{month} 直播保底</h2>
        <span className="muted">按主播名下全部账号的已采集时长计算</span>
      </div>
      <div className="guarantee-grid">
        {items.map((p) => (
          <article className="guarantee-card" key={p.anchor_id}>
            <div className="section-title">
              <strong>{p.name}</strong>
              {isAdmin && (
                <button
                  className="text-button"
                  onClick={() => onEdit(p)}
                  aria-label={`设置 ${p.name} 月度保底`}
                >
                  <Target size={15} />
                  设置保底
                </button>
              )}
            </div>
            <div>
              保底时长：{p.target == null ? "未设置" : duration(p.target)}
            </div>
            <div>已播时长：{duration(p.actual)}</div>
            <strong
              className={p.status === "below" ? "error-text" : "form-success"}
            >
              {p.status === "unset"
                ? "本月未设置保底"
                : p.status === "below"
                  ? `距离保底还差 ${duration(p.remaining)}`
                  : p.status === "met"
                    ? "已达到保底"
                    : `已超过保底 ${duration(p.excess)}`}
            </strong>
          </article>
        ))}
      </div>
    </section>
  );
}
export function GuaranteeForm({
  anchor,
  initialMonth,
  initialSeconds,
  Modal,
  onClose,
  onSave,
}) {
  const [month, setMonth] = useState(initialMonth),
    [hours, setHours] = useState(Math.floor((initialSeconds || 0) / 3600)),
    [minutes, setMinutes] = useState(
      Math.floor(((initialSeconds || 0) % 3600) / 60),
    ),
    [error, setError] = useState(""),
    [busy, setBusy] = useState(true),
    [loadedMonth, setLoadedMonth] = useState("");
  useEffect(() => {
    let disposed = false;
    if (!month) {
      setLoadedMonth("");
      setBusy(false);
      return;
    }
    setBusy(true);
    setError("");
    setLoadedMonth("");
    fetch(`/api/guarantees?month=${month}`)
      .then(async (r) => {
        const rows = await r.json();
        if (!r.ok) throw Error(rows.error);
        if (disposed) return;
        const p = rows.find((x) => x.anchor_id === anchor.id);
        setHours(Math.floor((p?.target || 0) / 3600));
        setMinutes(Math.floor(((p?.target || 0) % 3600) / 60));
        setLoadedMonth(month);
      })
      .catch((e) => {
        if (!disposed) setError(e.message);
      })
      .finally(() => {
        if (!disposed) setBusy(false);
      });
    return () => {
      disposed = true;
    };
  }, [month, anchor.id]);
  return (
    <Modal title={`${anchor.name} · 月度保底`} onClose={onClose}>
      <form
        onSubmit={async (e) => {
          e.preventDefault();
          setBusy(true);
          setError("");
          try {
            const response = await fetch(
              `/api/anchors/${anchor.id}/guarantee`,
              {
                method: "PUT",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({
                  month,
                  seconds: Number(hours) * 3600 + Number(minutes) * 60,
                }),
              },
            );
            const body = await response.json();
            if (!response.ok) throw Error(body.error || "保存失败");
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
          保底月份
          <input
            type="month"
            required
            value={month}
            onChange={(e) => setMonth(e.target.value)}
          />
        </label>
        <div className="form-grid">
          <label>
            保底小时
            <input
              type="number"
              required
              min="0"
              max="10000"
              step="1"
              value={hours}
              disabled={busy}
              onChange={(e) => setHours(e.target.value)}
            />
          </label>
          <label>
            保底分钟
            <input
              type="number"
              required
              min="0"
              max="59"
              step="1"
              value={minutes}
              disabled={busy}
              onChange={(e) => setMinutes(e.target.value)}
            />
          </label>
        </div>
        <p className="muted">
          只设置所选月份，不影响其他月份。月末最后7天未达标时，每天提醒一次；时长以已采集数据为准。
        </p>
        {error && <p className="form-error">{error}</p>}
        <footer>
          <button
            className="button primary"
            disabled={busy || loadedMonth !== month}
          >
            <Check size={16} />
            保存保底
          </button>
        </footer>
      </form>
    </Modal>
  );
}
