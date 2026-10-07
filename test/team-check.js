import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import net from "node:net";
import { spawn } from "node:child_process";
import { chromium } from "playwright";
import { Store } from "../server/store.js";
import { Auth } from "../server/auth.js";
import { Guarantees } from "../server/guarantees.js";
import { chinaDate, retentionStart, shiftDate } from "../server/domain.js";

const data = mkdtempSync(path.join(tmpdir(), "ledger-team-"));
const store = new Store(path.join(data, "live.sqlite"));
store.setSettings({ enabled: false, realtimeEnabled: false });
const auth = new Auth(store, data),
  guarantees = new Guarantees(store);
const anchors = ["组长甲", "组员乙", "组长丙", "组员丁", "未分组戊"].map(
  (name) => store.saveAnchor({ name }),
);
const [a, b, c, d, e] = anchors;
for (const [i, anchor] of anchors.entries())
  auth.save({
    anchorId: anchor.id,
    username: `team-${i}`,
    password: "test123",
    enabled: true,
  });
const accounts = anchors.map((anchor, i) =>
  store.createAccount({ anchorId: anchor.id, handle: `handle-${i}` }),
);
accounts.push(
  store.createAccount({ anchorId: b.id, handle: "member-second-account" }),
);
const today = chinaDate(),
  month = today.slice(0, 7);
for (const [i, account] of accounts.entries()) {
  const rows = [0, 1].map((n) => ({
    roomId: `team-${i}-${n}`,
    date: today,
    title: `场次-${i}-${n}`,
    start: today + ` ${10 + n}:00:00`,
    end: today + ` ${11 + n}:00:00`,
    duration: 3600,
    followers: 2,
    gifters: 3,
    fanclub: 1,
    commenters: 4,
    exposure: 100,
    entrants: 10,
    entry_rate: 10,
  }));
  store.saveDay(account.id, today, rows);
  const run = store.startRun(account.id, today, today, "manual");
  store.endRun(run, "success", `record-${i}`, 2);
}
for (const anchor of anchors) {
  guarantees.set(anchor.id, month, 100 * 3600, "admin");
  store.db
    .prepare(
      "INSERT OR IGNORE INTO guarantee_notices(anchor_id,date,message,created_at) VALUES(?,?,?,?)",
    )
    .run(anchor.id, today, `${anchor.name}保底提醒`, new Date().toISOString());
}
// Empty authorization scopes must never fall back to all anchors.
assert.equal(store.report(month, []).totals.duration, 0);
assert.equal(store.report(month, []).allTime.duration, 0);
assert.equal(guarantees.progress(month, []).length, 0);
assert.equal(store.runCount([]), 0);
store.close();
const password = readFileSync(path.join(data, "initial-admin.txt"), "utf8")
  .split("\n")
  .find((l) => l.startsWith("Password: "))
  .slice(10);
const port = await new Promise((resolve) => {
  const s = net.createServer();
  s.listen(0, "127.0.0.1", () => {
    const p = s.address().port;
    s.close(() => resolve(p));
  });
});
const base = `http://127.0.0.1:${port}`;
const child = spawn(
  process.execPath,
  ["--experimental-sqlite", "server/index.js"],
  {
    cwd: process.cwd(),
    env: { ...process.env, LIVE_DATA_DIR: data, PORT: String(port) },
    windowsHide: true,
    stdio: ["ignore", "pipe", "pipe"],
  },
);
let logs = "",
  browser;
child.stdout.on("data", (d) => (logs += d));
child.stderr.on("data", (d) => (logs += d));
const request = (cookie, url, method = "GET", body) =>
  fetch(base + url, {
    method,
    headers: { Cookie: cookie, "Content-Type": "application/json" },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
const json = async (cookie, url) => {
  const r = await request(cookie, url);
  assert.equal(r.status, 200, url);
  return r.json();
};
const login = async (username, password) => {
  const r = await request("", "/api/auth/login", "POST", {
    username,
    password,
  });
  assert.equal(r.status, 200);
  return r.headers
    .getSetCookie()
    .find(
      (v) =>
        v.startsWith("ledger_session=") && !v.startsWith("ledger_session=;"),
    )
    .split(";")[0];
};
try {
  for (let i = 0; i < 80; i++) {
    try {
      if ((await fetch(base + "/api/health")).ok) break;
    } catch {}
    if (i === 79) throw Error(logs);
    await new Promise((r) => setTimeout(r, 250));
  }
  const admin = await login("admin", password),
    leader = await login("team-0", "test123"),
    member = await login("team-1", "test123"),
    otherLeader = await login("team-2", "test123");
  const setTeam = async (anchor, isLeader, leaderId = "", expected = 200) =>
    assert.equal(
      (
        await request(admin, `/api/anchors/${anchor.id}/team`, "PUT", {
          isLeader,
          leaderId,
        })
      ).status,
      expected,
    );
  await setTeam(a, true);
  await setTeam(c, true);
  await setTeam(b, false, a.id);
  await setTeam(d, false, c.id);
  await setTeam(a, false, "", 400); // Members must be reassigned first.
  await setTeam(b, false, b.id, 400);
  await setTeam(b, false, e.id, 400);
  await setTeam(a, true, c.id, 400);
  let state = await json(leader, "/api/state");
  assert.equal(state.user.is_leader, true);
  assert.deepEqual(
    new Set(state.anchors.map((x) => x.id)),
    new Set([a.id, b.id]),
  );
  assert.equal(state.accounts.length, 3);
  const report = await json(leader, `/api/report?month=${month}`);
  assert.equal(report.totals.duration, 21600);
  assert.equal(report.allTime.duration, 21600);
  assert.equal(report.sessions.length, 6);
  assert.equal(report.daily.find((x) => x.date === today).sessions, 6);
  assert.equal(report.coverage.length, 3);
  assert.equal(report.guarantees.length, 2);
  assert.equal(
    (await json(leader, `/api/report?month=${month}&anchorId=${b.id}`)).totals
      .duration,
    14400,
  );
  assert.equal(
    (
      await json(
        leader,
        `/api/report?month=${month}&accountId=${accounts[5].id}`,
      )
    ).totals.duration,
    7200,
  );
  assert.equal((await json(leader, "/api/guarantees")).length, 2);
  assert.equal((await json(leader, "/api/runs")).total, 3);
  assert.equal((await json(member, "/api/state")).anchors.length, 1);
  assert.equal((await json(otherLeader, "/api/state")).accounts.length, 2);
  const notices = await json(leader, "/api/notices");
  assert.equal(notices.length, 2);
  assert.equal(
    (
      await request(
        leader,
        `/api/notices/${notices.find((x) => x.anchor_id === b.id).id}/read`,
        "POST",
        {},
      )
    ).status,
    200,
  );
  const foreignNotice = (await json(admin, "/api/notices")).find(
    (x) => x.anchor_id === d.id,
  );
  assert.equal(
    (await request(leader, `/api/notices/${foreignNotice.id}/read`, "POST", {}))
      .status,
    400,
  );
  const csv = await (
    await request(
      leader,
      `/api/export?month=${month}&kind=sessions&date=${today}`,
    )
  ).text();
  assert.ok(csv.includes("组员乙"));
  assert.ok(!csv.includes("组员丁"));
  assert.ok(!csv.includes("未分组戊"));
  for (const url of [
    `/api/report?month=${month}&anchorId=${d.id}`,
    `/api/report?month=${month}&accountId=${accounts[4].id}`,
    `/api/export?month=${month}&anchorId=${c.id}`,
    `/api/export?month=${month}&accountId=${accounts[3].id}`,
  ])
    assert.equal((await request(leader, url)).status, 403);
  assert.equal(
    (await request(leader, `/api/report?month=${month}&anchorId[]=${a.id}`))
      .status,
    400,
  );
  for (const [url, method, body, expected] of [
    [`/api/anchors/${b.id}/team`, "PUT", { isLeader: true, leaderId: "" }, 403],
    [`/api/anchors/${b.id}/guarantee`, "PUT", { month, seconds: 0 }, 403],
    [`/api/anchors/${a.id}/guarantee`, "PUT", { month, seconds: 0 }, 403],
    [`/api/accounts/${accounts[1].id}`, "PATCH", { note: "forbidden" }, 404],
    [`/api/accounts/${accounts[1].id}/login`, "POST", {}, 404],
    [`/api/accounts/${accounts[1].id}/login/check`, "POST", {}, 404],
    [`/api/accounts/${accounts[1].id}/verification/image`, "GET", null, 404],
    ["/api/sync", "POST", { accountId: accounts[1].id }, 403],
  ])
    assert.equal(
      (await request(leader, url, method, body)).status,
      expected,
      url,
    );

  browser = await chromium.launch({
    channel: process.platform === "win32" ? "msedge" : undefined,
    headless: true,
  });
  const context = await browser.newContext({
    viewport: { width: 1440, height: 1080 },
  });
  const cookie = (value) => ({
    name: "ledger_session",
    value: value.split("=")[1],
    url: base,
  });
  await context.addCookies([cookie(admin)]);
  const page = await context.newPage(),
    errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  mkdirSync("test-output", { recursive: true });
  await page.goto(base + "/#anchors");
  const section = page
    .locator(".anchor-section")
    .filter({ has: page.getByRole("heading", { name: /未分组戊/ }) });
  await section.getByRole("button", { name: "组长与归属" }).click();
  await page.getByLabel("归属组长").selectOption(a.id);
  await page.screenshot({ path: "test-output/team-admin-settings.png" });
  await page.getByRole("button", { name: "保存分组" }).click();
  await page.getByLabel("归属组长").waitFor({ state: "hidden" });
  assert.equal((await json(leader, "/api/state")).anchors.length, 3);
  await setTeam(e, false);
  await context.addCookies([cookie(leader)]);
  await page.reload();
  await page.getByText("team-0 · 组长", { exact: true }).waitFor();
  assert.equal(
    await page.getByRole("button", { name: "添加抖音号", exact: true }).count(),
    1,
  );
  assert.equal(
    await page.getByRole("button", { name: "组长与归属", exact: true }).count(),
    0,
  );
  assert.equal(
    await page.getByRole("button", { name: "设置保底", exact: true }).count(),
    0,
  );
  await page.screenshot({ path: "test-output/team-leader-desktop.png" });
  await page.setViewportSize({ width: 390, height: 844 });
  assert.ok(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  );
  await page.screenshot({ path: "test-output/team-leader-mobile.png" });
  // Same sessions immediately see reassignment; stale filtered data is cleared by refresh.
  await page.goto(base + "/#overview");
  const filter = page
    .locator("select")
    .filter({ has: page.locator(`option[value="${b.id}"]`) });
  await filter.selectOption(b.id);
  await setTeam(b, false, c.id);
  await page.waitForFunction(
    (id) =>
      !Array.from(document.querySelectorAll("select option")).some(
        (o) => o.value === id,
      ),
    b.id,
  );
  state = await json(leader, "/api/state");
  assert.equal(state.anchors.length, 1);
  assert.equal(
    (await json(leader, `/api/report?month=${month}`)).totals.duration,
    7200,
  );
  assert.equal(
    (await request(leader, `/api/report?month=${month}&anchorId=${b.id}`))
      .status,
    403,
  );
  assert.equal(
    (await json(otherLeader, `/api/report?month=${month}`)).totals.duration,
    28800,
  );
  await setTeam(a, false);
  assert.equal((await json(leader, "/api/state")).user.is_leader, false);
  const oldMonth = shiftDate(retentionStart(), -1).slice(0, 7);
  const history = await json(leader, `/api/report?month=${oldMonth}`);
  assert.equal(history.retention.historical, true);
  assert.ok(history.daily.every((day) => day.state === "online_required"));
  assert.equal(history.guarantees.length, 0);
  const historyCsv = await (
    await request(leader, `/api/export?month=${oldMonth}`)
  ).text();
  assert.ok(historyCsv.includes("需在线提取"));
  await page.locator('input[type="month"]').fill(oldMonth);
  await page
    .getByRole("button", { name: "在线重新提取", exact: true })
    .waitFor();
  await page.screenshot({ path: "test-output/retention-history-mobile.png" });
  await page.getByRole("button", { name: "在线重新提取", exact: true }).click();
  assert.equal(
    await page.getByLabel("开始日期").inputValue(),
    `${oldMonth}-01`,
  );
  assert.equal(
    await page.getByLabel("开始日期").getAttribute("min"),
    "2020-01-01",
  );
  await page.screenshot({ path: "test-output/retention-online-form.png" });
  assert.deepEqual(errors, []);
  console.log(
    "Team API and desktop/mobile UI verification passed: scope, exports, multiple sessions/accounts, guarantees, read-only members, assignment and revocation.",
  );
} finally {
  await browser?.close();
  child.kill();
  await new Promise((resolve) => {
    if (child.exitCode !== null) resolve();
    else child.once("exit", resolve);
  });
}
