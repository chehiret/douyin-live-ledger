import { chromium } from "playwright";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import net from "node:net";
import { Store } from "../server/store.js";
import { readDetails, Collector } from "../server/collector.js";
import { chinaDate } from "../server/domain.js";

const out = path.resolve("test-output");
let adminCookie = "";
const fetch = (url, options = {}) =>
  globalThis.fetch(url, {
    ...options,
    headers: {
      ...options.headers,
      ...(adminCookie ? { Cookie: adminCookie } : {}),
    },
  });
await mkdir(out, { recursive: true });
const data = await mkdtemp(path.join(tmpdir(), "live-ledger-test-"));
const db = new Store(path.join(data, "live.sqlite"));
db.setSettings({ enabled: false });
const a = db.saveAnchor({ name: "林小夏", note: "晚间组 · 主号与备用号" }),
  b = db.saveAnchor({ name: "陈一诺", note: "白天组" });
const ac1 = db.createAccount({
    anchorId: a.id,
    handle: "test-account-01",
    note: "主号",
  }),
  ac2 = db.createAccount({
    anchorId: a.id,
    handle: "test-account-02",
    note: "备用号",
  }),
  ac3 = db.createAccount({ anchorId: b.id, handle: "test-account-03" });
for (const [i, ac] of [ac1, ac2, ac3].entries())
  db.updateAccount(ac.id, {
    status: i === 2 ? "expired" : "ready",
    nickname: ["小夏的直播间", "小夏日常", "一诺"][i],
    error: i === 2 ? "登录已失效，请重新扫码" : "",
  });
const month = "2026-08";
db.saveLoginCheck(
  ac1.id,
  "unknown",
  "检测失败，网络或浏览器异常，暂时无法确认登录状态",
);
db.saveLoginCheck(ac1.id, "valid", "已使用保存的登录环境进入抖音后台");
let id = 7664998569060993000n;
for (let day = 1; day <= 31; day++)
  for (const [index, ac] of [ac1, ac2, ac3].entries()) {
    const date = `${month}-${String(day).padStart(2, "0")}`;
    const sessions =
      day % 6 === 0
        ? []
        : Array.from(
            { length: index === 0 && day % 3 === 0 ? 2 : 1 },
            (_, i) => ({
              roomId: String(id++),
              date,
              title: "测试场次",
              start: `${date} ${i ? "20" : "14"}:00:00`,
              end: `${date} ${i ? "22" : "16"}:00:00`,
              duration: 3600 + day * 43 + index * 521,
              followers: day * 2 + index * 3,
              gifters: (day % 8) + index,
              fanclub: day + i,
              commenters: day * 3 + i,
              exposure: 1000,
              entrants: 125,
              entry_rate: 12.5,
            }),
          );
    db.saveDay(ac.id, date, sessions);
  }
const run = db.startRun(ac1.id, "2026-08-01", "2026-08-31", "manual");
db.endRun(run, "success", "测试样本已核对", 35);
db.close();
const port = await new Promise((resolve) => {
  const s = net.createServer();
  s.listen(0, "127.0.0.1", () => {
    const p = s.address().port;
    s.close(() => resolve(p));
  });
});
const child = spawn(
  process.execPath,
  ["--experimental-sqlite", "server/index.js"],
  {
    cwd: process.cwd(),
    env: { ...process.env, PORT: String(port), LIVE_DATA_DIR: data },
    windowsHide: true,
    stdio: ["ignore", "pipe", "pipe"],
  },
);
let serverLogs = "";
child.stdout.on("data", (d) => (serverLogs += d));
child.stderr.on("data", (d) => (serverLogs += d));
let browser, page;
try {
  for (let i = 0; i < 80; i++) {
    try {
      const r = await fetch(`http://127.0.0.1:${port}/api/health`);
      if (r.ok) break;
    } catch {}
    await new Promise((r) => setTimeout(r, 250));
    if (i === 79) throw new Error(serverLogs);
  }
  browser = await chromium.launch({
    channel: process.platform === "win32" ? "msedge" : undefined,
    headless: true,
  });
  page = await browser.newPage({ viewport: { width: 1440, height: 1080 } });
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  const base = `http://127.0.0.1:${port}`;
  const initial = await readFile(path.join(data, "initial-admin.txt"), "utf8");
  const password = initial
    .split("\n")
    .find((line) => line.startsWith("Password: "))
    .slice(10);
  await page.goto(base);
  await page.getByRole("heading", { name: "账号登录", exact: true }).waitFor();
  await page.screenshot({ path: path.join(out, "system-login.png") });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.screenshot({ path: path.join(out, "system-login-390.png") });
  assert.equal(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
    true,
  );
  await page.setViewportSize({ width: 1440, height: 1080 });
  await page.getByLabel("登录账号", { exact: true }).fill("admin");
  await page.getByLabel("密码", { exact: true }).fill(password);
  await page.getByRole("button", { name: "登录", exact: true }).click();
  await page
    .getByRole("heading", { name: "直播数据", exact: true, level: 1 })
    .waitFor();
  adminCookie = (await page.context().cookies())
    .filter((c) => c.name === "ledger_session")
    .map((c) => `${c.name}=${c.value}`)
    .join("; ");
  assert.ok(adminCookie);
  for (const [id, title] of [
    ["overview", "直播数据"],
    ["anchors", "主播与账号"],
    ["logs", "同步记录"],
    ["settings", "同步设置"],
  ]) {
    await page.getByRole("button", { name: title, exact: true }).click();
    assert.equal(new URL(page.url()).hash, `#${id}`);
    await page.reload();
    await page
      .getByRole("heading", { name: title, exact: true, level: 1 })
      .waitFor();
    assert.equal(
      await page.locator(".nav-item.active").getAttribute("aria-label"),
      title,
    );
  }
  await page.goBack();
  await page
    .getByRole("heading", { name: "同步记录", exact: true, level: 1 })
    .waitFor();
  await page.goForward();
  await page
    .getByRole("heading", { name: "同步设置", exact: true, level: 1 })
    .waitFor();
  await page.goto(`${base}/#unknown`);
  await page
    .getByRole("heading", { name: "直播数据", exact: true, level: 1 })
    .waitFor();
  await page.getByLabel("统计月份").fill(month);
  await page.getByText("2026 / 08 / 01").waitFor();
  await page
    .getByRole("button", { name: "2026-08-01 场次明细", exact: true })
    .waitFor();
  await page.screenshot({
    path: path.join(out, "desktop-overview.png"),
    fullPage: false,
  });
  const report = await (
    await fetch(base + "/api/report?month=" + month)
  ).json();
  assert.equal(
    await page.locator(".metric-value").nth(1).textContent(),
    new Intl.NumberFormat("zh-CN").format(report.totals.followers),
  );
  await page.getByLabel("筛选主播").selectOption(a.id);
  await page.waitForFunction(
    () => document.querySelectorAll(".rank-row").length === 1,
  );
  await page
    .getByRole("button", { name: `设置 ${a.name} 月度保底`, exact: true })
    .click();
  await page.getByRole("button", { name: "保存保底", exact: true }).waitFor();
  await page.waitForFunction(() =>
    [...document.querySelectorAll("button")].some(
      (b) => b.textContent.includes("保存保底") && !b.disabled,
    ),
  );
  await page.getByLabel("保底小时", { exact: true }).fill("100");
  await page.getByRole("button", { name: "保存保底", exact: true }).click();
  await page.getByRole("dialog").waitFor({ state: "hidden" });
  assert.equal(
    (await (await fetch(base + `/api/guarantees?month=${month}`)).json()).find(
      (p) => p.anchor_id === a.id,
    ).target,
    360000,
  );
  await page
    .getByRole("button", { name: "2026-08-01 场次明细", exact: true })
    .click();
  await page.locator(".day-details").waitFor();
  assert.equal(await page.locator(".day-details>div").count(), 2);
  await page.getByLabel("场次日期", { exact: true }).fill("2026-08-03");
  await page
    .getByRole("columnheader", { name: "评论人数", exact: true })
    .waitFor();
  assert.equal(await page.locator("tbody tr").count(), 3);
  assert.ok((await page.locator("tbody").innerText()).includes("2026-08-03"));
  const dailyCsv = await (
    await fetch(
      base +
        `/api/export?month=${month}&kind=sessions&anchorId=${a.id}&date=2026-08-03`,
    )
  ).text();
  assert.equal(dailyCsv.trim().split("\r\n").length, 4);
  assert.ok(dailyCsv.includes("加粉丝团人数"));
  await page.locator(".records").scrollIntoViewIfNeeded();
  await page.screenshot({
    path: path.join(out, "multiple-sessions-desktop.png"),
  });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.locator(".records-toolbar").scrollIntoViewIfNeeded();
  await page.screenshot({
    path: path.join(out, "multiple-sessions-mobile.png"),
  });
  assert.equal(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
    true,
  );
  await page.setViewportSize({ width: 1440, height: 1080 });
  await page.getByLabel("场次日期", { exact: true }).fill("2026-08-06");
  await page.getByText("该日期暂无已采集场次", { exact: true }).waitFor();
  await page.getByRole("button", { name: "查看整月场次", exact: true }).click();
  await page.getByRole("button", { name: /场次明细 \d+/ }).click();
  assert.ok((await page.locator("tbody tr").count()) > 0);
  const csv = await (
    await fetch(base + "/api/export?month=" + month + "&kind=sessions")
  ).text();
  assert.ok(csv.includes("7664998569060993"));
  await page.getByRole("button", { name: "主播与账号", exact: true }).click();
  await page
    .getByRole("button", { name: "开通登录账号", exact: true })
    .first()
    .click();
  await page.getByLabel("登录账号", { exact: true }).fill("anchor-one");
  await page
    .getByLabel("初始密码", { exact: true })
    .fill("Fixture-password-123");
  await page.getByRole("button", { name: "保存账号", exact: true }).click();
  await page.getByRole("dialog").waitFor({ state: "hidden" });
  assert.equal(
    (await (await fetch(base + "/api/users")).json()).find(
      (u) => u.anchor_id === a.id,
    ).username,
    "anchor-one",
  );
  let releaseCheck;
  const checkGate = new Promise((resolve) => {
    releaseCheck = resolve;
  });
  await page.route(`**/api/accounts/${ac1.id}/login/check`, async (route) => {
    assert.equal(route.request().method(), "POST");
    await checkGate;
    await route.fulfill({
      json: { result: "valid", message: "已使用保存的登录环境进入抖音后台" },
    });
  });
  await page
    .getByRole("button", { name: "检测登录状态", exact: true })
    .first()
    .click();
  await page.getByRole("button", { name: "检测中", exact: true }).waitFor();
  assert.equal(
    await page
      .getByRole("button", { name: "重新登录", exact: true })
      .first()
      .isDisabled(),
    false,
  );
  releaseCheck();
  await page
    .getByRole("button", { name: "检测中", exact: true })
    .waitFor({ state: "hidden" });
  await page.getByRole("button", { name: "检测记录", exact: true }).click();
  await page
    .getByRole("dialog")
    .getByText("无法确认", { exact: true })
    .waitFor();
  await page
    .getByRole("dialog")
    .getByText("登录有效", { exact: true })
    .waitFor();
  await page.getByRole("button", { name: "关闭", exact: true }).click();
  await page.getByRole("button", { name: "添加主播", exact: true }).click();
  await page.getByLabel("主播名称", { exact: true }).fill("验收主播");
  await page.getByLabel("主播备注", { exact: true }).fill("流程验证");
  await page.getByRole("button", { name: "保存主播", exact: true }).click();
  await page.getByRole("heading", { name: "验收主播" }).waitFor();
  await page.getByRole("dialog").waitFor({ state: "hidden" });
  await page
    .getByRole("button", { name: "编辑账号 test-account-02", exact: true })
    .click();
  await page.getByLabel("所属主播", { exact: true }).selectOption(b.id);
  await page.getByRole("button", { name: "保存修改", exact: true }).click();
  await page.waitForFunction(() => !document.querySelector('[role="dialog"]'));
  assert.equal(
    (await (await fetch(base + "/api/state")).json()).accounts.find(
      (x) => x.id === ac2.id,
    ).anchor_id,
    b.id,
  );
  await page.screenshot({
    path: path.join(out, "desktop-accounts.png"),
    fullPage: false,
  });
  await page.getByRole("button", { name: "同步设置", exact: true }).click();
  await page.getByLabel("执行时间（北京时间）", { exact: true }).fill("05:30");
  await page.getByLabel("更新间隔", { exact: true }).selectOption("3");
  await page.getByRole("button", { name: "保存设置", exact: true }).click();
  await page.getByText("同步设置已保存", { exact: true }).waitFor();
  assert.equal(
    (await (await fetch(base + "/api/state")).json()).schedule.time,
    "05:30",
  );
  assert.equal(
    (await (await fetch(base + "/api/state")).json()).schedule.intervalMinutes,
    3,
  );
  await page.setViewportSize({ width: 390, height: 844 });
  await page.screenshot({ path: path.join(out, "realtime-settings-390.png") });
  assert.equal(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
    true,
  );
  for (const width of [390, 768]) {
    for (const [view, title] of [
      ["jobs", "任务队列"],
      ["notices", "通知中心"],
      ["audits", "操作记录"],
      ["backups", "数据备份"],
    ]) {
      await page.setViewportSize({ width, height: 844 });
      await page.getByRole("button", { name: title, exact: true }).click();
      await page
        .getByRole("heading", { name: title, level: 1, exact: true })
        .waitFor();
      await page.screenshot({ path: path.join(out, `${view}-${width}.png`) });
      assert.equal(
        await page.evaluate(
          () => document.documentElement.scrollWidth <= innerWidth,
        ),
        true,
        `${view} overflow at ${width}`,
      );
    }
    await page.setViewportSize({ width, height: 844 });
    await page.getByRole("button", { name: "直播数据", exact: true }).click();
    await page.locator(".metrics").waitFor();
    await page.screenshot({
      path: path.join(out, `overview-${width}.png`),
      fullPage: false,
    });
    assert.equal(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= window.innerWidth,
      ),
      true,
      `body overflow at ${width}`,
    );
    await page.getByRole("button", { name: "主播与账号", exact: true }).click();
    await page.screenshot({
      path: path.join(out, `accounts-${width}.png`),
      fullPage: false,
    });
    await page.getByRole("button", { name: "添加主播", exact: true }).click();
    await page.getByRole("dialog").waitFor();
    await page.screenshot({
      path: path.join(out, `modal-${width}.png`),
      fullPage: false,
    });
    assert.equal(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= window.innerWidth,
      ),
      true,
    );
    await page.getByRole("button", { name: "关闭", exact: true }).click();
  }
  await page.setViewportSize({ width: 1440, height: 1080 });
  await page.getByRole("button", { name: "数据备份", exact: true }).click();
  await page.getByRole("button", { name: "立即备份", exact: true }).click();
  await page
    .getByRole("button", { name: "校验", exact: true })
    .first()
    .waitFor();
  await page.getByRole("button", { name: "校验", exact: true }).first().click();
  await page.getByText(/校验通过：/).waitFor();
  const backupRows = await (await fetch(base + "/api/backups")).json();
  assert.ok(backupRows.length);
  assert.equal(
    (await fetch(base + `/api/backups/${backupRows[0].name}/download`)).status,
    200,
  );
  assert.ok(
    (
      await (
        await fetch(base + `/api/backups/${backupRows[0].name}/manifest`)
      ).json()
    ).sha256,
  );
  await page.screenshot({ path: path.join(out, "backups-desktop.png") });
  const opsSeed = new Store(path.join(data, "live.sqlite"));
  opsSeed.db
    .prepare(
      "INSERT INTO guarantee_notices(anchor_id,date,message,created_at) VALUES(?,?,?,?)",
    )
    .run(a.id, chinaDate(), "验收通知", new Date().toISOString());
  opsSeed.db
    .prepare(
      "INSERT INTO guarantee_notices(anchor_id,date,message,created_at) VALUES(?,?,?,?)",
    )
    .run(b.id, chinaDate(), "其他主播通知", new Date().toISOString());
  opsSeed.db
    .prepare(
      "INSERT INTO jobs(id,account_id,kind,payload,dedupe,status,created_at,available_at) VALUES(?,?,'check','{}',?,'queued',?,?)",
    )
    .run(
      "fixture-job",
      ac1.id,
      "fixture",
      new Date().toISOString(),
      Date.now() + 3600000,
    );
  opsSeed.close();
  await page.getByRole("button", { name: "任务队列", exact: true }).click();
  await page.getByRole("button", { name: "取消", exact: true }).click();
  await page
    .getByRole("button", { name: "取消", exact: true })
    .waitFor({ state: "hidden" });
  await page.getByRole("button", { name: "通知中心", exact: true }).click();
  const noticeRow = page.getByRole("row").filter({ hasText: "验收通知" });
  await noticeRow.getByRole("button", { name: "标记已读" }).click();
  await noticeRow
    .getByRole("button", { name: "标记已读" })
    .waitFor({ state: "hidden" });
  await page.getByRole("button", { name: "操作记录", exact: true }).click();
  await page
    .getByRole("cell", { name: "修改抖音号", exact: true })
    .first()
    .waitFor();
  const disposable = await (
    await fetch(base + "/api/accounts", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ anchorId: a.id, handle: "delete-test" }),
    })
  ).json();
  const profile = path.join(data, "profiles", disposable.id);
  await mkdir(profile, { recursive: true });
  await writeFile(path.join(profile, "fixture.txt"), "fixture");
  assert.equal(
    (
      await fetch(base + `/api/accounts/${disposable.id}`, {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ confirmation: "删除" }),
      })
    ).status,
    400,
  );
  await page.getByRole("button", { name: "主播与账号", exact: true }).click();
  await page.reload();
  await page
    .getByRole("button", { name: "删除抖音号 delete-test", exact: true })
    .click();
  await page.getByLabel("输入“确认删除”").fill("确认删除");
  await page.screenshot({ path: path.join(out, "delete-account-desktop.png") });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.screenshot({ path: path.join(out, "delete-account-390.png") });
  assert.equal(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
    true,
  );
  await page.setViewportSize({ width: 1440, height: 1080 });
  await page.getByRole("button", { name: "确认删除", exact: true }).click();
  await page.getByRole("dialog").waitFor({ state: "hidden" });
  assert.equal(
    (await (await fetch(base + "/api/state")).json()).accounts.some(
      (a) => a.id === disposable.id,
    ),
    false,
  );
  await assert.rejects(() => readFile(path.join(profile, "fixture.txt")), {
    code: "ENOENT",
  });
  // Exercise the actual DOM reader with the observed page structure and nonzero values.
  const detail = await browser.newPage();
  await detail.setContent(
    `<div class="basic-time"><span class="basic-time-label">开播时间：</span><span class="basic-time-value">2026-07-21 22:37:14</span></div><div class="basic-time"><span class="basic-time-label">关播时间：</span><span class="basic-time-value">2026-07-21 23:39:22</span></div><div class="basic-time"><span class="basic-time-label">直播时长：</span><span class="basic-time-value">1小时2分钟8秒</span></div><div class="indicator-card-item"><div class="indicator-card-item-label">送礼人数</div><div class="indicator-card-item-value-wrap">17</div></div><div class="indicator-card-item"><div class="indicator-card-item-label">新增粉丝</div><div class="indicator-card-item-value-wrap">1,234</div></div>`,
  );
  await detail
    .locator("body")
    .evaluate((e) =>
      e.insertAdjacentHTML(
        "beforeend",
        '<div class="indicator-card-item"><div class="indicator-card-item-label">加粉丝团人数</div><div class="indicator-card-item-value-wrap">7</div></div><div class="indicator-card-item"><div class="indicator-card-item-label">评论人数</div><div class="indicator-card-item-value-wrap">23</div></div>',
      ),
    );
  await detail.locator("body").evaluate((e) => {
    for (const [label, value] of [
      ["曝光人数", "1,000"],
      ["进房人数", "125"],
      ["进房率", "12.50 %"],
    ]) {
      e.insertAdjacentHTML(
        "beforeend",
        `<div class="indicator-card-item"><div class="indicator-card-item-label">${label}</div><div class="indicator-card-item-value-wrap">${value}</div></div>`,
      );
    }
  });
  const parsed = await readDetails(detail, "7664998569060993807");
  assert.equal(parsed.exposure, 1000);
  assert.equal(parsed.entrants, 125);
  assert.equal(parsed.entry_rate, 12.5);
  assert.equal(parsed.fanclub, 7);
  assert.equal(parsed.commenters, 23);
  await detail
    .locator(".indicator-card-item")
    .filter({ hasText: "评论人数" })
    .locator(".indicator-card-item-value-wrap")
    .evaluate((e) => (e.textContent = "--"));
  await assert.rejects(
    () => readDetails(detail, "7664998569060993807"),
    /评论人数不是精确整数/,
  );
  assert.equal(parsed.duration, 3728);
  assert.equal(parsed.followers, 1234);
  assert.equal(parsed.gifters, 17);
  await detail.setContent(
    `<iframe style="width:300px;height:240px" srcdoc='<div class="animate_qrcode_container"><canvas width="178" height="179"></canvas></div>'></iframe>`,
  );
  const qrCollector = new Collector(null, data);
  qrCollector.bindings.set("test", { page: detail });
  const qr = await qrCollector.bindingImage("test");
  assert.ok(qr);
  assert.equal(qr.readUInt32BE(16), 178);
  assert.equal(qr.readUInt32BE(20), 179);
  // Official center logo is valid; an overlay across the whole QR is not.
  await detail.setContent(
    '<div id="animate_qrcode_container" style="position:relative;width:180px;height:180px"><canvas width="180" height="180"></canvas><div style="position:absolute;width:30px;height:30px;left:75px;top:75px;background:black">logo</div></div>',
  );
  assert.ok(await qrCollector.bindingImage("test"));
  await detail.locator("#animate_qrcode_container").evaluate((e) => {
    const mask = document.createElement("div");
    mask.style = "position:absolute;inset:0;background:white";
    e.append(mask);
  });
  assert.equal(await qrCollector.bindingImage("test"), null);
  await detail.setContent("<p>Login loading</p>");
  assert.equal(await qrCollector.bindingImage("test"), null);
  // New-account flow does not ask for a handle and closes only after verified login.
  let bindingPhase = "queued",
    autoAccountId;
  await page.route("**/api/accounts/*/login", async (route) => {
    autoAccountId = new URL(route.request().url()).pathname.split("/")[3];
    await route.fulfill({
      json: {
        phase: bindingPhase,
        message:
          bindingPhase === "queued"
            ? "正在完成当前同步，完成后优先显示二维码"
            : bindingPhase === "mismatch"
              ? "这个抖音账号已被绑定，请联系管理员核对归属"
              : "等待扫码登录",
        canShow: bindingPhase === "waiting",
      },
    });
  });
  await page.route("**/api/accounts/*/qr?*", (route) =>
    route.fulfill({ contentType: "image/png", body: qr }),
  );
  await page.goto(base + "/#anchors");
  await page
    .getByRole("button", { name: "添加抖音号", exact: true })
    .first()
    .click();
  assert.equal(await page.getByLabel("抖音号", { exact: true }).count(), 0);
  await page.getByLabel("账号备注", { exact: true }).fill("自动扫码测试");
  await page.screenshot({ path: path.join(out, "auto-account-form.png") });
  await page.getByRole("button", { name: "保存并扫码", exact: true }).click();
  await page.getByRole("heading", { name: "扫码优先排队中" }).waitFor();
  assert.ok(autoAccountId);
  const autoState = await (await fetch(base + "/api/state")).json();
  assert.equal(
    autoState.accounts.find((a) => a.id === autoAccountId).handle,
    "",
  );
  bindingPhase = "waiting";
  await page
    .getByRole("button", { name: "打开官方登录页", exact: true })
    .waitFor();
  await page.waitForFunction(() => {
    const img = document.querySelector('img[alt="抖音官方登录二维码"]');
    return img?.complete && img.naturalWidth > 0;
  });
  await page.screenshot({ path: path.join(out, "auto-account-qr.png") });
  bindingPhase = "error";
  await page
    .getByRole("button", { name: "重新开始扫码", exact: true })
    .waitFor();
  bindingPhase = "waiting";
  await page.getByRole("button", { name: "重新开始扫码", exact: true }).click();
  await detail.setViewportSize({ width: 580, height: 420 });
  await detail.setContent(
    '<main style="padding:28px;font:16px sans-serif"><h2>身份验证</h2><p>请在官方页面完成身份验证</p><button style="padding:20px;width:100%">接收短信验证码</button><p>验证码输入框</p><input placeholder="请输入验证码" style="padding:14px" /></main>',
  );
  const verificationFixture = await detail.screenshot({ type: "jpeg" });
  let verificationInput;
  let smsState = null;
  await page.route("**/api/accounts/*/verification/frame", (route) =>
    route.fulfill({
      json: {
        image: `data:image/jpeg;base64,${verificationFixture.toString("base64")}`,
        width: 580,
        height: 420,
        frameId: "fixture-frame",
        sms: smsState,
      },
    }),
  );
  await page.route("**/api/accounts/*/verification/input", (route) => {
    verificationInput = route.request().postDataJSON();
    if (verificationInput.type === "sms-request")
      smsState = {
        stage: "code",
        phone: "193******51",
        seconds: 54,
        canRequest: false,
        message: "",
      };
    return route.fulfill({ json: { ok: true } });
  });
  bindingPhase = "verification";
  await page.getByAltText("抖音官方登录验证页面", { exact: true }).waitFor();
  assert.equal(await page.getByRole("dialog").count(), 1);
  assert.equal(
    await page
      .getByRole("button", { name: "本机验证窗口", exact: true })
      .count(),
    0,
  );
  await page.setViewportSize({ width: 390, height: 844 });
  await page.screenshot({ path: path.join(out, "inline-sms-mobile.png") });
  assert.ok(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  );
  await page
    .getByAltText("抖音官方登录验证页面", { exact: true })
    .click({ position: { x: 50, y: 50 } });
  await page.waitForTimeout(100);
  assert.equal(verificationInput.frameId, "fixture-frame");
  await page.getByLabel("验证输入内容").fill("123456");
  await page.getByRole("button", { name: "输入验证码", exact: true }).click();
  await page.waitForTimeout(100);
  assert.equal(verificationInput.text, "123456");
  await page.setViewportSize({ width: 1440, height: 1080 });
  await page.screenshot({ path: path.join(out, "inline-sms-desktop.png") });
  smsState = {
    stage: "choose",
    phone: "",
    seconds: 0,
    canRequest: true,
    message: "",
  };
  await page.getByRole("button", { name: "获取验证码", exact: true }).click();
  await page.getByLabel("短信验证码", { exact: true }).fill("123456");
  assert.equal(verificationInput.type, "sms-request");
  assert.equal(
    await page.getByRole("button", { name: "输入验证码", exact: true }).count(),
    0,
  );
  assert.ok(
    await page.getByRole("button", { name: /秒后重新获取/ }).isDisabled(),
  );
  await page.setViewportSize({ width: 390, height: 844 });
  await page.screenshot({ path: path.join(out, "simple-sms-mobile.png") });
  assert.ok(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  );
  await page.getByRole("button", { name: "验证登录", exact: true }).click();
  await page.waitForTimeout(100);
  assert.deepEqual(verificationInput, { type: "sms-submit", code: "123456" });
  smsState = { ...smsState, message: "验证码错误，请重试" };
  await page.getByText("验证码错误，请重试", { exact: true }).waitFor();
  await page
    .getByRole("button", { name: "使用官方界面 / 其他验证方式", exact: true })
    .click();
  await page.getByAltText("抖音官方登录验证页面", { exact: true }).waitFor();
  await page
    .getByRole("button", { name: "返回简洁短信验证", exact: true })
    .click();
  await page.setViewportSize({ width: 1440, height: 1080 });
  await page.screenshot({ path: path.join(out, "simple-sms-desktop.png") });
  bindingPhase = "mismatch";
  await page
    .getByRole("heading", { name: "账号需要核对", exact: true })
    .waitFor();
  await page
    .getByText("这个抖音账号已被绑定，请联系管理员核对归属", { exact: true })
    .waitFor();
  assert.equal(await page.getByAltText("抖音官方登录验证页面").count(), 0);
  assert.equal(
    await page
      .getByRole("button", { name: "打开官方登录页", exact: true })
      .count(),
    0,
  );
  bindingPhase = "finishing";
  await page
    .getByText("正在保存登录状态，即将自动关闭…", { exact: true })
    .waitFor();
  assert.equal(await page.getByRole("dialog").count(), 1);
  assert.equal(await page.getByAltText("抖音官方登录验证页面").count(), 0);
  const bindSeed = new Store(path.join(data, "live.sqlite"));
  bindSeed.updateAccount(autoAccountId, {
    nickname: "扫码识别昵称",
    douyin_uid: "998877665544332211",
    douyin_handle: "identified_handle",
    status: "ready",
  });
  bindSeed.close();
  bindingPhase = "ready";
  await page.getByRole("dialog").waitFor({ state: "hidden" });
  await page.getByText("抖音号：identified_handle", { exact: true }).waitFor();
  await page.unroute("**/api/accounts/*/login");
  await page.unroute("**/api/accounts/*/qr?*");
  await page.unroute("**/api/accounts/*/verification/frame");
  await page.unroute("**/api/accounts/*/verification/input");
  assert.equal(
    (
      await fetch(base + `/api/accounts/${autoAccountId}`, {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ confirmation: "确认删除" }),
      })
    ).status,
    200,
  );
  assert.deepEqual(errors, []);
  // Separate browser sessions must remain scoped even when the client supplies another owner's IDs.
  const viewerContext = await browser.newContext();
  const viewer = await viewerContext.newPage();
  await viewer.goto(base + "/#settings");
  await viewer.getByLabel("登录账号", { exact: true }).fill("anchor-one");
  await viewer.getByLabel("密码", { exact: true }).fill("Fixture-password-123");
  await viewer.getByRole("button", { name: "登录", exact: true }).click();
  await viewer
    .getByRole("heading", { name: "直播数据", exact: true, level: 1 })
    .waitFor();
  assert.equal(
    await viewer.getByRole("button", { name: "同步设置", exact: true }).count(),
    0,
  );
  await viewer.getByRole("button", { name: "主播与账号", exact: true }).click();
  assert.equal(
    await viewer.getByRole("button", { name: "添加主播", exact: true }).count(),
    0,
  );
  assert.equal(
    await viewer.getByRole("heading", { name: /陈一诺/ }).count(),
    0,
  );
  const vr = viewerContext.request;
  const state = await (await vr.get(base + "/api/state")).json();
  assert.deepEqual(
    state.accounts.map((a) => a.id),
    [ac1.id],
  );
  assert.equal(state.users.length, 0);
  assert.equal(state.anchors.length, 1);
  const privateReport = await (
    await vr.get(base + "/api/report?month=" + month)
  ).json();
  assert.ok(privateReport.sessions.every((s) => s.account_id === ac1.id));
  assert.equal(privateReport.allTime.sessions, privateReport.sessions.length);
  const privateCsv = await (
    await vr.get(base + "/api/export?month=" + month + "&kind=sessions")
  ).text();
  assert.ok(!privateCsv.includes("一诺"));
  for (const endpoint of ["report", "export"])
    for (const parameter of [`anchorId=${b.id}`, `accountId=${ac3.id}`])
      assert.equal(
        (
          await vr.get(`${base}/api/${endpoint}?month=${month}&${parameter}`)
        ).status(),
        403,
      );
  for (const [method, suffix] of [
    ["get", "login"],
    ["get", "qr"],
    ["post", "login"],
    ["post", "login/show"],
    ["post", "login/check"],
    ["post", "login/refresh"],
    ["delete", "login"],
    ["post", "approval"],
    ["get", "verification/image"],
    ["get", "verification/frame"],
    ["post", "verification/input"],
    ["patch", ""],
    ["delete", ""],
  ])
    assert.equal(
      (
        await vr[method](
          `${base}/api/accounts/${ac3.id}${suffix ? "/" + suffix : ""}`,
          { data: {} },
        )
      ).status(),
      404,
      method + suffix,
    );
  assert.equal((await vr.get(base + "/api/users")).status(), 403);
  assert.equal(
    (
      await vr.delete(base + `/api/accounts/${ac1.id}`, {
        data: { handle: ac1.handle },
      })
    ).status(),
    403,
  );
  assert.equal((await vr.get(base + "/api/backups")).status(), 403);
  assert.equal((await vr.get(base + "/api/audits")).status(), 403);
  assert.equal(
    (await vr.post(base + "/api/backups", { data: {} })).status(),
    403,
  );
  const privateRuns = await (await vr.get(base + "/api/runs?page=1")).json();
  assert.equal(privateRuns.pageSize, 15);
  assert.equal(
    (
      await vr.put(base + `/api/anchors/${a.id}/guarantee`, {
        data: { month, seconds: 0 },
      })
    ).status(),
    403,
  );
  const privateGuarantees = await (
    await vr.get(base + `/api/guarantees?month=${month}&anchorId=${b.id}`)
  ).json();
  assert.equal(privateGuarantees.length, 1);
  assert.equal(privateGuarantees[0].anchor_id, a.id);
  assert.equal(privateGuarantees[0].target, 360000);
  await viewer.getByRole("button", { name: "直播数据", exact: true }).click();
  await viewer.getByLabel("统计月份").fill(month);
  await viewer.getByText(/距离保底还差/).waitFor();
  assert.equal(await viewer.locator("tbody tr").count(), 15);
  assert.ok((await viewer.locator("tfoot").innerText()).includes("直播时长"));
  await viewer.getByRole("button", { name: "数据下一页", exact: true }).click();
  assert.equal(await viewer.locator("tbody tr").count(), 15);
  await viewer.getByRole("button", { name: "数据下一页", exact: true }).click();
  assert.equal(await viewer.locator("tbody tr").count(), 1);
  await viewer.setViewportSize({ width: 390, height: 844 });
  await viewer.locator(".guarantee-section").scrollIntoViewIfNeeded();
  await viewer.screenshot({
    path: path.join(out, "guarantee-anchor-mobile.png"),
  });
  assert.equal(
    await viewer.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
    true,
  );
  const privateNotices = await (await vr.get(base + "/api/notices")).json();
  assert.ok(privateNotices.every((n) => n.anchor_id === a.id));
  assert.ok(privateRuns.items.every((r) => r.account_id === ac1.id));
  assert.equal(
    (
      await vr.post(base + "/api/anchors", { data: { name: "forged" } })
    ).status(),
    403,
  );
  assert.equal(
    (await vr.patch(base + "/api/schedule", { data: {} })).status(),
    403,
  );
  assert.equal(
    (await vr.post(base + "/api/sync/stop", { data: {} })).status(),
    403,
  );
  assert.equal(
    (
      await vr.post(base + "/api/sync", { data: { accountId: ac3.id } })
    ).status(),
    403,
  );
  assert.equal(
    (
      await vr.patch(base + "/api/accounts/" + ac1.id, {
        data: { anchorId: b.id, enabled: true },
      })
    ).status(),
    400,
  );
  const pending = await (
    await vr.post(base + "/api/accounts", {
      data: { anchorId: b.id, handle: "pending-viewer", approval: "approved" },
    })
  ).json();
  assert.equal(pending.anchor_id, a.id);
  assert.equal(pending.approval, "pending");
  assert.equal(
    (
      await vr.post(base + `/api/accounts/${pending.id}/approval`, {
        data: { approval: "approved" },
      })
    ).status(),
    403,
  );
  assert.equal(
    (
      await vr.post(base + "/api/sync", { data: { accountId: pending.id } })
    ).status(),
    400,
  );
  assert.equal(
    (
      await fetch(base + `/api/accounts/${pending.id}/approval`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ approval: "approved" }),
      })
    ).status,
    400,
  );
  const seed = new Store(path.join(data, "live.sqlite"));
  seed.updateAccount(pending.id, {
    status: "ready",
    nickname: "审核样本",
    douyin_uid: "1234567890123456789",
  });
  seed.close();
  assert.equal(
    (
      await fetch(base + `/api/accounts/${pending.id}/approval`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ approval: "approved" }),
      })
    ).status,
    200,
  );
  await viewer.screenshot({ path: path.join(out, "anchor-portal.png") });
  const viewerUser = (await (await fetch(base + "/api/users")).json()).find(
    (u) => u.anchor_id === a.id,
  );
  await fetch(base + `/api/users/${viewerUser.id}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      username: viewerUser.username,
      password: "",
      enabled: false,
    }),
  });
  assert.equal((await vr.get(base + "/api/state")).status(), 401);
  assert.equal((await globalThis.fetch(base + "/api/state")).status, 401);
  await viewerContext.close();
  const secondUserResponse = await fetch(base + "/api/users", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      username: "anchor-two",
      password: "Second-password-123",
      anchorId: b.id,
      enabled: true,
    }),
  });
  assert.equal(secondUserResponse.status, 201);
  const secondContext = await browser.newContext();
  const secondPage = await secondContext.newPage();
  await secondPage.goto(base);
  await secondPage.getByLabel("登录账号", { exact: true }).fill("anchor-two");
  await secondPage
    .getByLabel("密码", { exact: true })
    .fill("Second-password-123");
  await secondPage.getByRole("button", { name: "登录", exact: true }).click();
  await secondPage
    .getByRole("heading", { name: "直播数据", exact: true, level: 1 })
    .waitFor();
  const secondState = await (
    await secondContext.request.get(base + "/api/state")
  ).json();
  assert.deepEqual(
    new Set(secondState.accounts.map((a) => a.id)),
    new Set([ac2.id, ac3.id]),
  );
  assert.equal(
    (
      await secondContext.request.get(base + `/api/accounts/${ac1.id}/login`)
    ).status(),
    404,
  );
  await secondPage
    .getByRole("button", { name: "修改登录密码", exact: true })
    .click();
  await secondPage
    .getByLabel("当前密码", { exact: true })
    .fill("Second-password-123");
  await secondPage
    .getByLabel("新密码", { exact: true })
    .fill("Changed-password-123");
  await secondPage
    .getByLabel("确认新密码", { exact: true })
    .fill("Changed-password-123");
  await secondPage
    .getByRole("button", { name: "保存并重新登录", exact: true })
    .click();
  await secondPage
    .getByRole("heading", { name: "账号登录", exact: true })
    .waitFor();
  assert.equal(
    (await secondContext.request.get(base + "/api/state")).status(),
    401,
  );
  const oldPassword = await secondContext.request.post(
    base + "/api/auth/login",
    { data: { username: "anchor-two", password: "Second-password-123" } },
  );
  assert.equal(oldPassword.status(), 401);
  await secondPage.getByLabel("登录账号", { exact: true }).fill("anchor-two");
  await secondPage
    .getByLabel("密码", { exact: true })
    .fill("Changed-password-123");
  await secondPage.getByRole("button", { name: "登录", exact: true }).click();
  await secondPage
    .getByRole("heading", { name: "直播数据", exact: true, level: 1 })
    .waitFor();
  await secondPage
    .getByRole("button", { name: "退出登录", exact: true })
    .click();
  await secondPage
    .getByRole("heading", { name: "账号登录", exact: true })
    .waitFor();
  await secondContext.close();
  assert.equal(
    (
      await fetch(base + "/api/state", {
        headers: { Origin: "https://example.com" },
      })
    ).status,
    403,
  );
  await writeFile(
    path.join(out, "verification.json"),
    JSON.stringify(
      {
        passed: true,
        checks: [
          "monthly totals",
          "multiple-account aggregation",
          "drilldown",
          "CSV",
          "anchor creation",
          "account reassignment",
          "schedule persistence",
          "390/768/1440 layouts",
          "nonzero DOM reader",
          "iframe QR crop and no full-page fallback",
          "cross-site rejection",
        ],
        pageErrors: errors,
      },
      null,
      2,
    ),
  );
  console.log("UI verification passed. Artifacts: " + out);
} catch (e) {
  if (page) {
    await page
      .screenshot({ path: path.join(out, "failure.png") })
      .catch(() => {});
    await writeFile(
      path.join(out, "failure.txt"),
      (await page
        .locator("body")
        .innerText()
        .catch(() => "")) +
        "\n" +
        e.message,
    );
  }
  throw e;
} finally {
  await browser?.close();
  child.kill();
  await new Promise((resolve) => {
    if (child.exitCode !== null) return resolve();
    child.once("exit", resolve);
  });
}
