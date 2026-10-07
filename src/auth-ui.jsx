import React, { useEffect, useState } from "react";
import { Activity, LogIn, Check } from "lucide-react";

async function authApi(url, method = "GET", body) {
  const res = await fetch(url, {
    method,
    headers: { "Content-Type": "application/json" },
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || "请求失败");
  return data;
}
export function AuthGate({ children }) {
  const [user, setUser] = useState(null),
    [loading, setLoading] = useState(true),
    [error, setError] = useState(""),
    [busy, setBusy] = useState(false);
  useEffect(() => {
    authApi("/api/auth/me")
      .then((r) => setUser(r.user))
      .catch((e) => setError(e.message))
      .finally(() => setLoading(false));
    const expired = () => {
      setUser(null);
      setError("登录已过期，请重新登录");
    };
    window.addEventListener("auth-expired", expired);
    return () => window.removeEventListener("auth-expired", expired);
  }, []);
  async function logout() {
    try {
      await authApi("/api/auth/logout", "POST");
      setUser(null);
      setError("");
    } catch (e) {
      setError(e.message);
    }
  }
  if (loading) return <div className="auth-screen">正在加载…</div>;
  if (user) return children(user, logout);
  return (
    <main className="auth-screen">
      <section className="auth-form">
        <div className="brand">
          <span className="brand-icon">
            <Activity size={24} />
          </span>
          <strong>主播数据管理器</strong>
        </div>
        <h1>账号登录</h1>
        <form
          onSubmit={async (e) => {
            e.preventDefault();
            setBusy(true);
            setError("");
            const form = new FormData(e.currentTarget);
            try {
              const r = await authApi("/api/auth/login", "POST", {
                username: form.get("username"),
                password: form.get("password"),
              });
              setUser(r.user);
            } catch (err) {
              setError(err.message);
            } finally {
              setBusy(false);
            }
          }}
        >
          <label>
            登录账号
            <input
              name="username"
              autoComplete="username"
              required
              maxLength={60}
            />
          </label>
          <label>
            密码
            <input
              name="password"
              type="password"
              autoComplete="current-password"
              required
              maxLength={128}
            />
          </label>
          {error && (
            <p className="form-error" role="alert">
              {error}
            </p>
          )}
          <button className="button primary" disabled={busy}>
            <LogIn size={16} />
            {busy ? "登录中" : "登录"}
          </button>
        </form>
      </section>
    </main>
  );
}
export function UserAccessForm({ Modal, anchor, user, onClose, onSave }) {
  const [error, setError] = useState(""),
    [busy, setBusy] = useState(false);
  return (
    <Modal
      title={`${anchor.name} · ${user ? "管理登录账号" : "开通登录账号"}`}
      onClose={onClose}
    >
      <form
        onSubmit={async (e) => {
          e.preventDefault();
          setBusy(true);
          setError("");
          const form = new FormData(e.currentTarget);
          try {
            await authApi(
              user ? `/api/users/${user.id}` : "/api/users",
              user ? "PATCH" : "POST",
              {
                anchorId: anchor.id,
                username: form.get("username"),
                password: form.get("password"),
                enabled: form.get("enabled") === "on",
              },
            );
            await onSave();
            onClose();
          } catch (err) {
            setError(err.message);
          } finally {
            setBusy(false);
          }
        }}
      >
        <label>
          登录账号
          <input
            name="username"
            required
            pattern="[a-zA-Z0-9_@.\-]{3,60}"
            maxLength={60}
            defaultValue={user?.username || ""}
            autoComplete="off"
          />
        </label>
        <label>
          {user ? "重置密码（留空保留）" : "初始密码"}
          <input
            name="password"
            type="password"
            minLength={6}
            maxLength={128}
            required={!user}
            autoComplete="new-password"
          />
        </label>
        <label className="checkbox-row">
          <input
            name="enabled"
            type="checkbox"
            defaultChecked={user ? user.enabled : true}
          />
          允许登录
        </label>
        {error && (
          <p className="form-error" role="alert">
            {error}
          </p>
        )}
        <footer>
          <button className="button" type="button" onClick={onClose}>
            取消
          </button>
          <button className="button primary" disabled={busy}>
            <Check size={16} />
            保存账号
          </button>
        </footer>
      </form>
    </Modal>
  );
}
export function PasswordForm({ Modal, onClose, onSave }) {
  const [error, setError] = useState(""),
    [busy, setBusy] = useState(false);
  return (
    <Modal title="修改登录密码" onClose={onClose}>
      <form
        onSubmit={async (e) => {
          e.preventDefault();
          setError("");
          const form = new FormData(e.currentTarget);
          if (form.get("password") !== form.get("confirm")) {
            setError("两次新密码不一致");
            return;
          }
          setBusy(true);
          try {
            await authApi("/api/auth/password", "POST", {
              currentPassword: form.get("currentPassword"),
              password: form.get("password"),
            });
            await onSave();
          } catch (err) {
            setError(err.message);
          } finally {
            setBusy(false);
          }
        }}
      >
        <label>
          当前密码
          <input
            name="currentPassword"
            type="password"
            required
            maxLength={128}
            autoComplete="current-password"
          />
        </label>
        <label>
          新密码
          <input
            name="password"
            type="password"
            required
            minLength={6}
            maxLength={128}
            autoComplete="new-password"
          />
        </label>
        <label>
          确认新密码
          <input
            name="confirm"
            type="password"
            required
            minLength={6}
            maxLength={128}
            autoComplete="new-password"
          />
        </label>
        {error && (
          <p className="form-error" role="alert">
            {error}
          </p>
        )}
        <footer>
          <button className="button primary" disabled={busy}>
            <Check size={16} />
            保存并重新登录
          </button>
        </footer>
      </form>
    </Modal>
  );
}
