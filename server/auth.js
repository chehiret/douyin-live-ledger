import {
  randomBytes,
  randomUUID,
  scryptSync,
  timingSafeEqual,
  createHash,
} from "node:crypto";
import { writeFileSync } from "node:fs";
import path from "node:path";

const publicUser = (u) =>
  u && {
    id: u.id,
    username: u.username,
    role: u.role,
    anchor_id: u.anchor_id,
    enabled: Boolean(u.enabled),
  };
const digest = (value) => createHash("sha256").update(value).digest("hex");
function hashPassword(password) {
  const salt = randomBytes(16).toString("hex");
  return `${salt}:${scryptSync(password, salt, 64).toString("hex")}`;
}
function verify(password, hash) {
  const [salt, expected] = hash.split(":");
  return timingSafeEqual(
    Buffer.from(expected, "hex"),
    scryptSync(password, salt, 64),
  );
}
function credentials(username, password) {
  if (typeof username !== "string" || !/^[a-zA-Z0-9_@.-]{3,60}$/.test(username))
    throw new Error("登录账号须为3至60位字母、数字或 _ @ . -");
  if (
    typeof password !== "string" ||
    password.length < 6 ||
    password.length > 128
  )
    throw new Error("密码须为6至128位");
}
export class Auth {
  constructor(store, dataDir) {
    this.db = store.db;
    this.db.exec(`CREATE TABLE IF NOT EXISTS users(
      id TEXT PRIMARY KEY,username TEXT NOT NULL UNIQUE,password_hash TEXT NOT NULL,
      role TEXT NOT NULL CHECK(role IN ('admin','anchor')),anchor_id TEXT UNIQUE REFERENCES anchors(id),
      enabled INTEGER NOT NULL DEFAULT 1,created_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS auth_sessions(token_hash TEXT PRIMARY KEY,user_id TEXT NOT NULL REFERENCES users(id),expires_at INTEGER NOT NULL);`);
    this.dummyHash = hashPassword(randomBytes(24).toString("hex"));
    if (!this.db.prepare("SELECT id FROM users WHERE role='admin'").get()) {
      const password = randomBytes(18).toString("base64url");
      const id = randomUUID();
      this.db
        .prepare("INSERT INTO users VALUES(?,?,?,'admin',NULL,1,?)")
        .run(id, "admin", hashPassword(password), new Date().toISOString());
      writeFileSync(
        path.join(dataDir, "initial-admin.txt"),
        `Username: admin\nPassword: ${password}\nChange this password after signing in.\n`,
        { mode: 0o600 },
      );
    }
  }
  list() {
    return this.db
      .prepare(
        "SELECT id,username,role,anchor_id,enabled FROM users ORDER BY created_at",
      )
      .all()
      .map(publicUser);
  }
  save(input, id) {
    const old =
      id &&
      this.db
        .prepare("SELECT * FROM users WHERE id=? AND role='anchor'")
        .get(id);
    if (id && !old) throw new Error("主播登录账号不存在");
    const username = input.username?.trim();
    credentials(username, input.password || (old ? "unchanged-password" : ""));
    const anchorId = old?.anchor_id || input.anchorId;
    if (!this.db.prepare("SELECT id FROM anchors WHERE id=?").get(anchorId))
      throw new Error("主播不存在");
    if (typeof input.enabled !== "boolean") throw new Error("账号状态不正确");
    if (
      this.db
        .prepare("SELECT id FROM users WHERE username=? AND id!=?")
        .get(username, id || "")
    )
      throw new Error("登录账号已存在");
    if (
      !old &&
      this.db.prepare("SELECT id FROM users WHERE anchor_id=?").get(anchorId)
    )
      throw new Error("该主播已开通登录账号");
    const userId = id || randomUUID();
    const hash = input.password
      ? hashPassword(input.password)
      : old.password_hash;
    this.db
      .prepare(
        `INSERT INTO users VALUES(?,?,?,'anchor',?,?,?) ON CONFLICT(id) DO UPDATE SET username=excluded.username,password_hash=excluded.password_hash,enabled=excluded.enabled`,
      )
      .run(
        userId,
        username,
        hash,
        anchorId,
        input.enabled ? 1 : 0,
        new Date().toISOString(),
      );
    if (old)
      this.db.prepare("DELETE FROM auth_sessions WHERE user_id=?").run(userId);
    return this.list().find((u) => u.id === userId);
  }
  token(req) {
    return (
      req.headers.cookie
        ?.split(";")
        .map((s) => s.trim())
        .find((s) => s.startsWith("ledger_session="))
        ?.slice(15) || ""
    );
  }
  user(req) {
    const token = this.token(req);
    if (!/^[a-f0-9]{64}$/.test(token)) return null;
    return publicUser(
      this.db
        .prepare(
          "SELECT u.* FROM users u JOIN auth_sessions s ON s.user_id=u.id WHERE s.token_hash=? AND s.expires_at>? AND u.enabled=1",
        )
        .get(digest(token), Date.now()),
    );
  }
  login(req, res) {
    const now = Date.now();
    const { username, password } = req.body;
    const user =
      typeof username === "string" &&
      this.db
        .prepare("SELECT * FROM users WHERE username=?")
        .get(username.trim());
    const valid =
      typeof password === "string" &&
      password.length <= 128 &&
      verify(password, user?.password_hash || this.dummyHash);
    if (!valid || !user?.enabled) {
      return res.status(401).json({ error: "账号或密码错误，或账号已停用" });
    }
    this.logout(req, res);
    const token = randomBytes(32).toString("hex");
    this.db.prepare("DELETE FROM auth_sessions WHERE expires_at<=?").run(now);
    this.db
      .prepare("INSERT INTO auth_sessions VALUES(?,?,?)")
      .run(digest(token), user.id, now + 12 * 3600000);
    res.cookie("ledger_session", token, {
      httpOnly: true,
      sameSite: "strict",
      secure: req.secure,
      path: "/",
      maxAge: 12 * 3600000,
    });
    res.json({ user: publicUser(user) });
  }
  logout(req, res) {
    this.db
      .prepare("DELETE FROM auth_sessions WHERE token_hash=?")
      .run(digest(this.token(req)));
    res.clearCookie("ledger_session", {
      httpOnly: true,
      sameSite: "strict",
      secure: req.secure,
      path: "/",
    });
  }
  changePassword(user, input) {
    credentials(user.username, input.password);
    const row = this.db
      .prepare("SELECT password_hash FROM users WHERE id=?")
      .get(user.id);
    if (
      typeof input.currentPassword !== "string" ||
      input.currentPassword.length > 128 ||
      !verify(input.currentPassword, row.password_hash)
    )
      throw new Error("当前密码不正确");
    this.db
      .prepare("UPDATE users SET password_hash=? WHERE id=?")
      .run(hashPassword(input.password), user.id);
    this.db.prepare("DELETE FROM auth_sessions WHERE user_id=?").run(user.id);
  }
}
