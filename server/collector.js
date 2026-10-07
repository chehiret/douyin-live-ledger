import { dismissSubscriptionPopup } from "./subscription-popup.js";
import { chromium } from "playwright";
import { mkdir, writeFile } from "node:fs/promises";
import { existsSync, lstatSync } from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { cookieEditorCookies } from "./cookie-export.js";
import {
  chinaDate,
  datesBetween,
  parseSession,
  shiftDate,
  validateCollectionRange,
  retentionStart,
  validDate,
} from "./domain.js";

export const REVIEW = "https://anchor.douyin.com/anchor/review";
const LIVE_PANEL = ".semi-modal-body #semiTabPanel0";
const HISTORY_PATH =
  "/anchor_pc_tinker_proxy/lego/native/webcast_api/room/replay/history_list";
const DATA_PATHS = new Set([
  HISTORY_PATH,
  "/anchor_pc_tinker_proxy/lego/native/webcast_api/room/replay/overview_v3",
]);
const pause = (ms) => new Promise((r) => setTimeout(r, ms));
export class LoginRequired extends Error {}
export function calendarStartMatches(start, date) {
  return (
    typeof start === "string" &&
    /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(start) &&
    validDate(start.slice(0, 10)) &&
    start.slice(0, 10) <= date
  );
}
export async function loginChallenge(page) {
  let scanned = false;
  for (const frame of page.frames()) {
    const text = await frame
      .locator("body")
      .innerText({ timeout: 1500 })
      .catch(() => "");
    if (
      /安全验证|身份验证|手机刷脸验证|短信验证|验证手机号|验证码已发送|请输入收到的|输入.{0,8}验证码|拖动.{0,12}(滑块|拼图)|请完成.{0,8}验证/.test(
        text,
      )
    )
      return "verification";
    if (/扫码成功|扫描成功|请在手机.{0,8}确认|已扫码/.test(text))
      scanned = true;
  }
  return scanned ? "scanned" : null;
}
export async function readDetails(page, roomId, listedDuration) {
  await page.locator(".basic-time").first().waitFor({ timeout: 25000 });
  await page
    .locator(".indicator-card-item-value-wrap")
    .first()
    .waitFor({ timeout: 25000 });
  const raw = await page.evaluate(() => {
    const times = {};
    for (const e of document.querySelectorAll(".basic-time"))
      times[
        e
          .querySelector(".basic-time-label")
          ?.textContent?.replace(/[：:\s]/g, "")
      ] = e.querySelector(".basic-time-value")?.textContent?.trim();
    const metrics = {};
    for (const e of document.querySelectorAll(".indicator-card-item"))
      metrics[
        e.querySelector(".indicator-card-item-label")?.textContent?.trim()
      ] = e
        .querySelector(".indicator-card-item-value-wrap")
        ?.textContent?.trim();
    return {
      start: times["开播时间"],
      end: times["关播时间"],
      duration: times["直播时长"],
      followers: metrics["新增粉丝"],
      gifters: metrics["送礼人数"],
      fanclub: metrics["加粉丝团人数"],
      commenters: metrics["评论人数"],
      exposure: metrics["曝光人数"],
      entrants: metrics["进房人数"],
      entry_rate: metrics["进房率"] ?? "",
    };
  });
  return parseSession({
    ...raw,
    roomId,
    listedDuration,
    fanclub: raw.fanclub ?? "",
    commenters: raw.commenters ?? "",
    exposure: raw.exposure ?? "",
    entrants: raw.entrants ?? "",
  });
}

export class Collector {
  constructor(store, dataDir) {
    this.store = store;
    this.dataDir = dataDir;
    this.bindings = new Map();
    this.busy = false;
    this.checking = null;
    this.progress = null;
    this.context = null;
    this.stopping = false;
    this.preparedPages = new WeakSet();
    this.dataRequests = new WeakMap();
    this.identities = new WeakMap();
    this.handles = new WeakMap();
    this.maxBrowsers = 2;
    this.syncAccountId = null;
    this.exporting = null;
  }
  async launch(accountId, { visible = false, login = false } = {}) {
    const dir = path.join(this.dataDir, "profiles", accountId);
    await mkdir(dir, { recursive: true });
    const options = {
      headless: !visible,
      args: [],
      viewport: { width: 1440, height: 1000 },
      locale: "zh-CN",
      timezoneId: "Asia/Shanghai",
      acceptDownloads: false,
    };
    if (process.platform === "win32") options.channel = "msedge";
    const context = await chromium.launchPersistentContext(dir, options);
    context.on("response", async (response) => {
      const url = new URL(response.url());
      if (
        url.origin !== new URL(REVIEW).origin ||
        url.pathname !== "/passport/account/info/v2/"
      )
        return;
      try {
        const body = await response.json();
        // Retain only identity and an explicitly named public handle, never tokens.
        const raw = body?.data?.user_id_str;
        const uid =
          typeof raw === "string"
            ? raw
            : Number.isSafeInteger(raw)
              ? String(raw)
              : "";
        if (response.ok() && uid && /^\d+$/.test(uid))
          this.identities.set(response.frame().page(), uid);
        if (
          response.ok() &&
          typeof body?.data?.unique_id === "string" &&
          /^[a-zA-Z0-9_.-]{1,100}$/.test(body.data.unique_id)
        )
          this.handles.set(response.frame().page(), body.data.unique_id);
      } catch {}
    });
    return context;
  }
  identityConflict(account, page) {
    const uid = this.identities.get(page);
    if (!uid) return "无法确认抖音账号身份，请稍后重试";
    if (account.douyin_uid && uid !== account.douyin_uid)
      return "当前扫码账号与已绑定的抖音账号不同";
    if (
      this.store
        .listAccounts()
        .some((a) => a.id !== account.id && a.douyin_uid === uid)
    )
      return "这个抖音账号已被绑定，请联系管理员核对归属";
    if (
      [...this.bindings.values()].some(
        (b) => b.accountId !== account.id && b.verifiedUid === uid,
      )
    )
      return "这个抖音账号正在另一个窗口完成绑定，请勿重复扫码";
    return null;
  }
  async checkLogin(page) {
    if (new URL(page.url()).pathname.startsWith("/login"))
      throw new LoginRequired("登录已失效，请重新扫码");
    const text = await page.locator("body").innerText();
    if (
      /安全验证|完成验证|拖动滑块/.test(text) &&
      !(await page
        .getByRole("button", { name: "切换场次", exact: true })
        .count())
    )
      throw new LoginRequired("抖音需要验证，请打开本机验证窗口完成");
  }
  async nickname(page) {
    return (
      await page
        .locator('[class^="info-"] > span[class^="name-"]')
        .first()
        .textContent({ timeout: 10000 })
    ).trim();
  }
  async publicHandle(page) {
    if (this.handles.has(page)) return this.handles.get(page);
    // Read only an explicit handle label in the current account's identity panel.
    const info = await Promise.resolve()
      .then(() =>
        page.locator('[class^="info-"]').first().innerText({ timeout: 1500 }),
      )
      .catch(() => "");
    return (
      info.match(/抖音号\s*[:：]\s*([a-zA-Z0-9_.-]{1,100})(?=\s|$)/)?.[1] || ""
    );
  }
  async inspectLogin(page, account, timeout = 30000) {
    const deadline = Date.now() + timeout;
    while (Date.now() < deadline) {
      const challenge = await loginChallenge(page);
      if (challenge === "verification")
        return {
          result: "verification",
          message: "抖音要求安全或短信验证，请在官方窗口完成",
        };
      if (challenge === "scanned")
        return {
          result: "verification",
          message: "登录尚未完成，请在手机上确认",
        };
      const url = new URL(page.url());
      if (url.origin === new URL(REVIEW).origin) {
        if (url.pathname.startsWith("/anchor")) {
          const nick = await page
            .locator('[class^="info-"] > span[class^="name-"]')
            .first();
          if (await nick.isVisible()) {
            const name = (await nick.textContent()).trim();
            if (!this.identities.has(page)) {
              await pause(500);
              continue;
            }
            const conflict = this.identityConflict(account, page);
            if (conflict) return { result: "mismatch", message: conflict };
            if (
              name &&
              account.nickname &&
              !account.douyin_uid &&
              name !== account.nickname
            )
              return {
                result: "mismatch",
                message: "当前登录昵称与绑定记录不同，请核对账号或是否改过昵称",
              };
            if (name && account.nickname) {
              const handle = await this.publicHandle(page);
              if (handle)
                this.store.updateAccount(account.id, { douyin_handle: handle });
              if (this.identities.has(page))
                this.store.updateAccount(account.id, {
                  douyin_uid: this.identities.get(page),
                });
              return {
                result: "valid",
                message: "已使用保存的登录环境进入抖音后台",
              };
            }
          }
        }
        if (url.pathname.startsWith("/login")) {
          const body = await page.locator("body").innerText();
          if (/扫码登录|验证码登录|密码登录|登录抖音/.test(body))
            return {
              result: "expired",
              message: "抖音已要求重新登录，保存的登录状态当前不可用",
            };
        }
      }
      await pause(500);
    }
    return {
      result: "unknown",
      message: "未能确认登录状态，页面未就绪或结构发生变化，请稍后重试",
    };
  }
  exportCookies(accountId) {
    if (this.exporting || this.busy || this.checking || this.bindings.size)
      throw new Error("正在扫码、同步、检测或导出 Cookie，请任务结束后再导出");
    if (!this.store.account(accountId)) throw new Error("账号不存在");
    const profiles = path.resolve(this.dataDir, "profiles");
    const profile = path.resolve(profiles, accountId);
    if (
      !/^[a-f0-9-]{36}$/.test(accountId) ||
      path.dirname(profile) !== profiles ||
      !existsSync(profiles) ||
      !existsSync(profile)
    )
      throw new Error("该账号没有保存的登录环境，请先扫码绑定");
    if (
      lstatSync(profiles).isSymbolicLink() ||
      lstatSync(profile).isSymbolicLink() ||
      !lstatSync(profile).isDirectory()
    )
      throw new Error("登录环境路径不正确");
    // Reserve the browser before awaiting launch; queued jobs must wait too.
    this.exporting = accountId;
    this.exportTask = (async () => {
      let context;
      try {
        context = await this.launch(accountId);
        const cookies = cookieEditorCookies(await context.cookies());
        if (!cookies.length)
          throw new Error("没有可导出的抖音 Cookie，请先重新扫码登录");
        return cookies;
      } finally {
        try {
          await context?.close();
        } finally {
          this.exporting = null;
        }
      }
    })();
    return this.exportTask;
  }
  startLoginCheck(accountId) {
    if (
      this.busy ||
      this.exporting ||
      this.checking ||
      this.bindings.has(accountId) ||
      this.bindings.size >= this.maxBrowsers
    )
      throw new Error("已有同步、登录或检测任务，请稍后再试");
    const account = this.store.account(accountId);
    if (!account) throw new Error("账号不存在");
    this.checking = accountId;
    this.checkTask = (async () => {
      let outcome;
      try {
        this.checkContext = await this.launch(accountId);
        const page =
          this.checkContext.pages()[0] || (await this.checkContext.newPage());
        const response = await page.goto(REVIEW, {
          waitUntil: "domcontentloaded",
          timeout: 30000,
        });
        if (response && !response.ok()) throw new Error("HTTP failure");
        outcome = await this.inspectLogin(page, account);
      } catch {
        outcome = {
          result: "unknown",
          message: "检测失败，网络或浏览器异常，暂时无法确认登录状态",
        };
      } finally {
        await this.checkContext?.close().catch(() => {});
        this.checkContext = null;
      }
      try {
        const status = {
          valid: "ready",
          expired: "expired",
          verification: "verification",
          mismatch: "mismatch",
        }[outcome.result];
        // A successful login check does not clear a separate collection error.
        if (
          status &&
          !(outcome.result === "valid" && account.status === "error")
        )
          this.store.updateAccount(accountId, { status });
        return this.store.saveLoginCheck(
          accountId,
          outcome.result,
          outcome.message,
        );
      } finally {
        this.checking = null;
      }
    })();
    return this.checkTask;
  }
  async startBinding(accountId, visible = false) {
    if (this.bindings.has(accountId)) return this.bindingStatus(accountId);
    if (
      (this.busy &&
        (!this.syncAccountId || this.syncAccountId === accountId)) ||
      this.checking === accountId ||
      this.exporting
    )
      throw new Error("该账号正在同步或检测，请稍后再试");
    if (
      this.bindings.size +
        Number(Boolean(this.busy)) +
        Number(Boolean(this.checking)) >=
      this.maxBrowsers
    )
      throw new Error("当前两个浏览器任务正在使用中，请稍后再试");
    if (!this.store.account(accountId)) throw new Error("账号不存在");
    this.store.updateAccount(accountId, { status: "binding", error: "" });
    const state = {
      accountId,
      phase: "opening",
      message: "正在打开抖音官方登录页面",
      created: Date.now(),
      context: null,
      page: null,
      polling: false,
    };
    this.bindings.set(accountId, state);
    try {
      state.context = await this.launch(accountId, { visible, login: true });
      if (this.bindings.get(accountId) !== state) {
        await state.context.close();
        return this.bindingStatus(accountId);
      }
      state.page = state.context.pages()[0] || (await state.context.newPage());
      await state.page.goto(REVIEW, {
        waitUntil: "domcontentloaded",
        timeout: 60000,
      });
      if (this.bindings.get(accountId) !== state)
        return this.bindingStatus(accountId);
      state.phase = "waiting";
      state.message = "等待扫码登录";
      state.timer = setInterval(
        () =>
          this.pollBinding(accountId).catch((e) => {
            state.message =
              "登录状态检查失败，请重试：" + e.message.slice(0, 100);
          }),
        2000,
      );
      state.timer.unref();
      await this.pollBinding(accountId);
      return this.bindingStatus(accountId);
    } catch (e) {
      await this.cancelBinding(accountId);
      this.store.updateAccount(accountId, {
        status: "error",
        error: "无法打开登录浏览器：" + e.message.slice(0, 180),
      });
      throw e;
    }
  }
  bindingStatus(accountId) {
    const b = this.bindings.get(accountId);
    return b
      ? {
          phase: b.phase,
          message: b.message,
          canShow: Boolean(b.page && !b.page.isClosed()),
          elapsedSeconds: Math.floor((Date.now() - b.created) / 1000),
        }
      : {
          phase: this.store.account(accountId)?.status || "unbound",
          message: this.store.account(accountId)?.error || "",
        };
  }
  async pollBinding(accountId) {
    const b = this.bindings.get(accountId);
    if (!b || b.polling || !b.page) return;
    b.polling = true;
    try {
      if (Date.now() - b.created > 10 * 60000) {
        await this.cancelBinding(accountId);
        this.store.updateAccount(accountId, {
          status: "unbound",
          error: "扫码已超时，请重新绑定",
        });
        return;
      }
      if (b.page.isClosed()) {
        await this.cancelBinding(accountId);
        return;
      }
      if (!new URL(b.page.url()).pathname.startsWith("/anchor")) {
        const challenge = await loginChallenge(b.page);
        if (challenge) {
          b.phase = challenge;
          b.message =
            challenge === "verification"
              ? "抖音要求身份验证，请直接在当前弹窗完成"
              : "扫码成功，等待手机确认";
        } else {
          b.phase = "waiting";
          b.message = "请使用抖音扫码；二维码未显示时可打开官方登录页";
        }
        return;
      }
      if (b.phase !== "mismatch") {
        b.phase = "finishing";
        b.message = "正在核对账号并保存登录状态…";
      }
      const nick = await this.nickname(b.page).catch(() => null);
      if (!nick) return;
      const old = this.store.account(accountId);
      const uid = this.identities.get(b.page);
      if (!uid) {
        b.message = "正在核对抖音账号身份";
        return;
      }
      const conflict = this.identityConflict(old, b.page);
      if (
        conflict ||
        (!old.douyin_uid && old.nickname && old.nickname !== nick)
      ) {
        b.phase = "mismatch";
        b.message =
          conflict ||
          `当前登录昵称为“${nick}”，与已绑定的“${old.nickname}”不同，请核对账号后重新绑定`;
        return;
      }
      clearInterval(b.timer);
      b.verifiedUid = uid;
      const douyinHandle = await this.publicHandle(b.page);
      if (this.bindings.get(accountId) !== b) return;
      await b.context.close();
      if (this.bindings.get(accountId) !== b) return;
      this.bindings.delete(accountId);
      this.store.updateAccount(accountId, {
        status: "ready",
        nickname: nick,
        douyin_uid: uid,
        douyin_handle: douyinHandle,
        error: "",
      });
    } finally {
      b.polling = false;
    }
  }
  async bindingImage(accountId) {
    const b = this.bindings.get(accountId);
    if (
      !b?.page ||
      b.page.isClosed() ||
      ["verification", "scanned", "mismatch"].includes(b.phase)
    )
      return null;
    // Douyin can render its login widget in a cross-origin iframe.
    for (const frame of b.page.frames()) {
      for (const qr of [
        frame.getByAltText("二维码", { exact: true }).first(),
        frame
          .locator(
            '[class*="qrcode"] canvas, [class*="qrcode"] img, [id*="qrcode"] canvas, [id*="qrcode"] img',
          )
          .first(),
      ]) {
        if (await qr.isVisible().catch(() => false)) {
          const clear = await qr.evaluate((e) => {
            const r = e.getBoundingClientRect();
            // The official QR logo overlays its center. Require clear outer
            // samples so the logo is allowed while full challenge/expiry masks aren't.
            return [
              [0.15, 0.15],
              [0.85, 0.15],
              [0.15, 0.85],
              [0.85, 0.85],
            ].every(([x, y]) => {
              const top = document.elementFromPoint(
                r.x + r.width * x,
                r.y + r.height * y,
              );
              return top === e || e.contains(top);
            });
          });
          if (!clear) continue;
          const box = await qr.boundingBox();
          if (
            box &&
            box.width >= 100 &&
            box.height >= 100 &&
            box.width <= 450 &&
            box.height <= 450
          )
            return qr.screenshot({ type: "png", timeout: 5000 });
        }
      }
    }
    return null;
  }
  async refreshBinding(accountId) {
    const b = this.bindings.get(accountId);
    if (!b?.page) throw new Error("请先启动扫码登录");
    await b.page.reload({ waitUntil: "domcontentloaded" });
    b.phase = "waiting";
    b.message = "等待扫码登录";
    b.created = Date.now();
    await this.pollBinding(accountId);
    return this.bindingStatus(accountId);
  }
  async showBinding(accountId) {
    const b = this.bindings.get(accountId);
    if (!b?.page) throw new Error("登录浏览器尚未就绪，请等待扫码任务启动");
    const session = await b.context.newCDPSession(b.page);
    try {
      const { windowId } = await session.send("Browser.getWindowForTarget");
      await session.send("Browser.setWindowBounds", {
        windowId,
        bounds: { windowState: "normal" },
      });
      await b.page.bringToFront();
      return this.bindingStatus(accountId);
    } finally {
      await session.detach();
    }
  }
  async cancelBinding(accountId) {
    const b = this.bindings.get(accountId);
    if (!b) return;
    clearInterval(b.timer);
    this.bindings.delete(accountId);
    await b.context?.close().catch(() => {});
    this.store.updateAccount(accountId, { status: "unbound" });
  }
  verificationPage(accountId) {
    const b = this.bindings.get(accountId);
    if (!b?.page || b.page.isClosed())
      throw new Error("登录窗口已结束，请重新发起登录");
    const url = new URL(b.page.url());
    if (
      url.protocol !== "https:" ||
      !(url.hostname === "douyin.com" || url.hostname.endsWith(".douyin.com"))
    )
      throw new Error("当前不是抖音官方页面");
    return b.page;
  }
  async verificationImage(accountId) {
    return this.verificationPage(accountId).screenshot({
      type: "jpeg",
      quality: 75,
      timeout: 5000,
    });
  }
  async smsControls(page) {
    // Only recognize the official identity-verification SMS flow, never the
    // unrelated phone-login inputs that may be behind its dialog.
    const visibleOne = async (locator) => {
      const matches = [];
      for (const item of (await locator.all()).slice(0, 12))
        if (await item.isVisible().catch(() => false)) matches.push(item);
      return matches.length === 1 ? matches[0] : null;
    };
    for (const frame of page.frames()) {
      for (const heading of (
        await frame.getByText(/^接收短信验证码$/).all()
      ).slice(0, 6)) {
        if (!(await heading.isVisible().catch(() => false))) continue;
        let root = heading;
        for (let depth = 0; depth < 8; depth++) {
          root = root.locator("..");
          const box = await root.boundingBox().catch(() => null);
          if (!box || box.width < 280 || box.height < 240) continue;
          if (box.width > 1100 || box.height > 950) break;
          const input = await visibleOne(
            root.locator(
              'input[placeholder*="验证码"], input[autocomplete="one-time-code"]',
            ),
          );
          const confirm = await visibleOne(
            root.getByText(/^(验证|确认|确认登录|验证登录)$/),
          );
          const body = await root.innerText();
          const phone = body.match(/1\d{2}\*{4,8}\d{2,4}/)?.[0] || "";
          if (input && confirm) {
            const seconds = Number(
              body.match(
                /(\d{1,3})\s*(?:s|秒)\s*(?:后|后可)?\s*(?:重新|再次)/i,
              )?.[1] || 0,
            );
            const request = await visibleOne(
              root.getByText(
                /^(重新发送(?:验证码)?|重新获取(?:验证码)?|获取验证码|发送验证码)$/,
              ),
            );
            const message =
              body
                .split("\n")
                .map((s) => s.trim())
                .find((s) =>
                  /验证码.*(?:错误|不正确|失效|过期)|(?:操作|发送).*频繁|验证失败/.test(
                    s,
                  ),
                ) || "";
            return {
              root,
              input,
              confirm,
              request,
              state: {
                stage: "code",
                phone,
                seconds,
                canRequest: Boolean(
                  request && !seconds && (await request.isEnabled()),
                ),
                message: message.slice(0, 160),
              },
            };
          }
          if (!input && /身份验证/.test(body)) {
            const request = await visibleOne(
              root.getByText(/^接收短信验证码$/),
            );
            if (request)
              return {
                root,
                request,
                state: {
                  stage: "choose",
                  phone,
                  seconds: 0,
                  canRequest: await request.isEnabled(),
                  message: "",
                },
              };
          }
        }
      }
    }
    return null;
  }
  async smsState(page, binding) {
    const controls = await this.smsControls(page);
    if (!controls) return null;
    const seconds = Math.max(
      controls.state.seconds,
      Math.max(
        0,
        Math.ceil(
          (60000 - (Date.now() - (binding.smsRequestedAt || 0))) / 1000,
        ),
      ),
    );
    return {
      ...controls.state,
      seconds,
      canRequest: controls.state.canRequest && !seconds,
    };
  }
  async faceControls(page) {
    for (const frame of page.frames()) {
      for (const heading of (
        await frame.getByText(/^手机刷脸验证$/).all()
      ).slice(0, 6)) {
        if (!(await heading.isVisible().catch(() => false))) continue;
        let root = heading;
        for (let depth = 0; depth < 8; depth++) {
          root = root.locator("..");
          const box = await root.boundingBox().catch(() => null);
          if (!box || box.width < 280 || box.height < 240) continue;
          if (box.width > 1100 || box.height > 950) break;
          const text = await root.innerText();
          const one = async (pattern) => {
            const matches = [];
            for (const item of (await root.getByText(pattern).all()).slice(
              0,
              12,
            ))
              if (await item.isVisible().catch(() => false)) matches.push(item);
            return matches.length === 1 ? matches[0] : null;
          };
          if (/身份验证/.test(text) && /接收短信验证码|验证登录密码/.test(text))
            return {
              root,
              request: heading,
              state: { stage: "choose", available: await heading.isEnabled() },
            };
          if (/二维码|扫码|扫一扫|抖音APP/i.test(text)) {
            const refresh = await one(/^(刷新二维码|刷新|重新获取二维码)$/);
            const back = await one(/^(选择|更换|使用|切换)?其他验证方式$/);
            return {
              root,
              refresh,
              back,
              state: {
                stage: "qr",
                available: true,
                expired: /二维码.*(?:失效|过期)|(?:失效|过期).*二维码/.test(
                  text,
                ),
                canRefresh: Boolean(refresh && (await refresh.isEnabled())),
                canBack: Boolean(back && (await back.isEnabled())),
              },
            };
          }
        }
      }
    }
    return null;
  }
  async verificationFrame(accountId) {
    const page = this.verificationPage(accountId),
      b = this.bindings.get(accountId);
    const completed = () => {
      const url = new URL(page.url());
      return url.origin === new URL(REVIEW).origin &&
        url.pathname.startsWith("/anchor")
        ? {
            phase: b.phase === "mismatch" ? "mismatch" : "finishing",
            message:
              b.phase === "mismatch"
                ? b.message
                : "正在核对账号并保存登录状态…",
          }
        : null;
    };
    if (completed()) return completed();
    if (b.capturing) throw new Error("验证画面正在更新，请稍后重试");
    b.capturing = true;
    try {
      const viewport = page.viewportSize();
      let clip = { x: 0, y: 0, width: viewport.width, height: viewport.height };
      for (const frame of page.frames()) {
        const headings = await frame
          .getByText(
            /^(身份验证|安全验证|手机刷脸验证|短信验证|接收短信验证码|请输入验证码|验证身份)$/,
          )
          .all();
        for (const heading of headings.slice(0, 8)) {
          if (!(await heading.isVisible().catch(() => false))) continue;
          let candidate = heading;
          for (let depth = 0; depth < 8; depth++) {
            const box = await candidate.boundingBox().catch(() => null);
            if (
              box &&
              box.width >= 280 &&
              box.width <= 1100 &&
              box.height >= 240 &&
              box.height <= 950 &&
              box.x >= 0 &&
              box.y >= 0 &&
              box.x + box.width <= viewport.width &&
              box.y + box.height <= viewport.height
            ) {
              clip = {
                x: Math.floor(box.x),
                y: Math.floor(box.y),
                width: Math.floor(box.width),
                height: Math.floor(box.height),
              };
              break;
            }
            candidate = candidate.locator("..");
          }
          if (clip.width !== viewport.width) break;
        }
        if (clip.width !== viewport.width) break;
      }
      const image = await page.screenshot({
        type: "jpeg",
        quality: 75,
        clip,
        timeout: 5000,
      });
      if (this.bindings.get(accountId) !== b) throw new Error("登录已结束");
      if (completed()) return completed();
      const frameId = randomUUID();
      b.frames ||= new Map();
      b.frames.set(frameId, { ...clip, created: Date.now() });
      for (const [key, value] of b.frames)
        if (Date.now() - value.created > 30000 || b.frames.size > 20)
          b.frames.delete(key);
      return {
        image: `data:image/jpeg;base64,${image.toString("base64")}`,
        width: clip.width,
        height: clip.height,
        frameId,
        sms: await this.smsState(page, b),
        face: (await this.faceControls(page))?.state || null,
      };
    } finally {
      b.capturing = false;
    }
  }
  async verificationInput(accountId, input) {
    const page = this.verificationPage(accountId),
      b = this.bindings.get(accountId),
      viewport = page.viewportSize();
    if (b.interacting) throw new Error("请等待上一次操作完成");
    const point = (p) =>
      p &&
      Number.isFinite(p.x) &&
      Number.isFinite(p.y) &&
      p.x >= 0 &&
      p.y >= 0 &&
      p.x < viewport.width &&
      p.y < viewport.height;
    b.interacting = true;
    try {
      if (input.type === "sms-request" || input.type === "sms-submit") {
        const controls = await this.smsControls(page);
        if (!controls)
          throw new Error("当前不是短信验证界面，请使用下方官方界面继续");
        if (input.type === "sms-request") {
          if (
            !controls.state.canRequest ||
            Date.now() - (b.smsRequestedAt || 0) < 60000
          )
            throw new Error("请等待倒计时结束后再获取验证码");
          await controls.request.click({ timeout: 5000 });
          b.smsRequestedAt = Date.now();
        } else {
          if (!/^\d{6}$/.test(input.code || ""))
            throw new Error("请输入6位短信验证码");
          if (!controls.input || !controls.confirm)
            throw new Error("请先获取短信验证码");
          await controls.input.fill(input.code, { timeout: 5000 });
          await controls.confirm.click({ timeout: 5000 });
        }
      } else if (
        ["face-select", "face-refresh", "face-back"].includes(input.type)
      ) {
        const controls = await this.faceControls(page);
        const action =
          input.type === "face-select"
            ? controls?.request
            : input.type === "face-refresh"
              ? controls?.refresh
              : controls?.back;
        if (!action || !(await action.isEnabled()))
          throw new Error(
            "当前官方页面未提供此刷脸操作，请使用官方界面选择验证方式",
          );
        await action.click({ timeout: 5000 });
      } else if (input.type === "pointer") {
        let from = input.from,
          to = input.to;
        if (input.frameId) {
          const clip = b.frames?.get(input.frameId);
          const inside = (p) =>
            p &&
            Number.isFinite(p.x) &&
            Number.isFinite(p.y) &&
            p.x >= 0 &&
            p.y >= 0 &&
            p.x < clip.width &&
            p.y < clip.height;
          if (
            !clip ||
            Date.now() - clip.created > 30000 ||
            !inside(from) ||
            !inside(to)
          )
            throw new Error("验证画面已更新，请重新点击");
          from = { x: clip.x + from.x, y: clip.y + from.y };
          to = { x: clip.x + to.x, y: clip.y + to.y };
        }
        if (!point(from) || !point(to)) throw new Error("操作位置无效");
        await page.mouse.move(from.x, from.y);
        await page.mouse.down();
        try {
          await page.mouse.move(to.x, to.y, { steps: 12 });
        } finally {
          await page.mouse.up();
        }
      } else if (input.type === "text") {
        if (typeof input.text !== "string" || input.text.length > 128)
          throw new Error("输入内容过长");
        await page.keyboard.insertText(input.text);
      } else if (
        input.type === "key" &&
        ["Enter", "Backspace", "Tab", "Escape", "Control+A"].includes(input.key)
      )
        await page.keyboard.press(input.key);
      else if (
        input.type === "scroll" &&
        Number.isFinite(input.delta) &&
        Math.abs(input.delta) <= 1000
      )
        await page.mouse.wheel(0, input.delta);
      else throw new Error("不支持的操作");
      return { ok: true };
    } finally {
      b.interacting = false;
    }
  }
  async verifySyncLogin(page, account) {
    let outcome;
    try {
      outcome = await this.inspectLogin(page, account);
    } catch {
      outcome = {
        result: "unknown",
        message: "同步前检测失败，网络或页面异常，暂时无法确认登录状态",
      };
    }
    this.store.saveLoginCheck(
      account.id,
      outcome.result,
      `同步检测：${outcome.message}`,
    );
    if (outcome.result === "valid") return;
    const error =
      outcome.result === "unknown"
        ? new Error(outcome.message)
        : new LoginRequired(outcome.message);
    error.loginResult = outcome.result;
    throw error;
  }
  async openDate(page, date, beforeSelect = null) {
    if (!this.preparedPages.has(page)) {
      const tracker = { pending: new Set(), changed: Date.now(), errors: [] };
      this.dataRequests.set(page, tracker);
      page.on("request", (request) => {
        if (DATA_PATHS.has(new URL(request.url()).pathname)) {
          tracker.pending.add(request);
          tracker.changed = Date.now();
        }
      });
      page.on("requestfailed", (request) => {
        if (tracker.pending.delete(request)) {
          tracker.errors.push("数据请求未完成");
          tracker.changed = Date.now();
        }
      });
      page.on("response", async (response) => {
        const request = response.request();
        if (!tracker.pending.has(request)) return;
        try {
          const body = await response.json();
          if (
            !response.ok() ||
            !body?.data ||
            !Object.hasOwn(body.data, "series")
          )
            tracker.errors.push("抖音数据接口未返回有效统计结果");
        } catch {
          tracker.errors.push("无法读取抖音统计结果");
        } finally {
          tracker.pending.delete(request);
          tracker.changed = Date.now();
        }
      });
      const subscription = page
        .locator(".semi-popconfirm-popover")
        .filter({ hasText: "订阅直播复盘站内信" });
      await page.addLocatorHandler(
        subscription,
        () => dismissSubscriptionPopup(subscription),
        { noWaitAfter: true },
      );
      this.preparedPages.add(page);
    }
    this.dataRequests.get(page).errors = [];
    await page.goto(REVIEW, { waitUntil: "domcontentloaded", timeout: 60000 });
    if (beforeSelect) await beforeSelect();
    await this.checkLogin(page);
    const dismiss = page.getByRole("button", { name: "close", exact: true });
    if (await dismiss.isVisible().catch(() => false)) await dismiss.click();
    await page
      .getByRole("button", { name: "切换场次", exact: true })
      .click({ timeout: 25000 });
    const modal = page.locator(".semi-modal-body");
    await modal.getByRole("heading").first().waitFor({ timeout: 15000 });
    const targetMonth = date.slice(0, 7);
    for (let i = 0; i < 100; i++) {
      const h = await modal.getByRole("heading").first().innerText();
      const m = h.match(/(\d{4})年(\d{1,2})月/);
      if (!m) throw new Error("日历月份结构发生变化");
      const current = `${m[1]}-${m[2].padStart(2, "0")}`;
      if (current === targetMonth) break;
      const move = modal.getByRole("button", {
        name: current > targetMonth ? "上个月" : "下个月",
        exact: true,
      });
      if (await move.isDisabled())
        throw new Error("抖音暂不支持查询该历史月份，未保存为零数据");
      await move.click();
      await page.waitForFunction(
        (old) =>
          document.querySelector(".semi-modal-body h5")?.textContent !== old,
        h,
      );
      if (i === 99) throw new Error("超出抖音日历查询范围");
    }
    const [y, m, d] = date.split("-").map(Number);
    const dayCell = modal.locator(
      `[role="gridcell"][aria-label="${y}/${m}/${d}"]`,
    );
    if (
      (await dayCell.getAttribute("aria-disabled")) === "true" ||
      (await dayCell.isDisabled())
    )
      throw new Error("抖音暂不支持查询该历史日期，未保存为零数据");
    // Settle the default range first, then wait for this exact day's request.
    await this.waitForData(page);
    const responses = [];
    const matchesDate = (response) => {
      const url = new URL(response.url());
      return (
        url.origin === new URL(REVIEW).origin &&
        url.pathname === HISTORY_PATH &&
        url.searchParams.get("startDate") === date &&
        url.searchParams.get("endDate") === date
      );
    };
    const collectResponse = (response) => {
      if (!matchesDate(response)) return;
      responses.push(
        response
          .json()
          .then((body) =>
            response.ok() && Array.isArray(body?.data?.series)
              ? body.data.series.map((s) =>
                  typeof s.startTime === "string"
                    ? s.startTime.replace(/\s+/g, " ").trim()
                    : null,
                )
              : null,
          )
          .catch(() => null),
      );
    };
    page.on("response", collectResponse);
    try {
      // Live and linked-session lists can request the same date concurrently.
      // Match the visible live cards against the relevant settled response,
      // rather than assuming the first response belongs to the active tab.
      await Promise.all([
        page.waitForResponse(matchesDate, { timeout: 25000 }),
        dayCell.click(),
      ]);
      await page
        .locator(`${LIVE_PANEL}:visible`)
        .getByText(
          `${y}年${String(m).padStart(2, "0")}月${String(d).padStart(2, "0")}日`,
          { exact: true },
        )
        .waitFor({ timeout: 15000 });
      await this.waitForData(page);
      const expectedCount = (await dayCell.innerText()).match(
        /(\d+)\s*场/,
      )?.[1];
      await this.waitForCalendarCards(
        page,
        date,
        responses,
        20000,
        expectedCount == null ? null : Number(expectedCount),
      );
      await this.checkLogin(page);
      return modal;
    } finally {
      page.off("response", collectResponse);
    }
  }
  async waitForCalendarCards(
    page,
    date,
    responses,
    timeout = 20000,
    expectedCount = null,
  ) {
    const deadline = Date.now() + timeout;
    this.calendarEvidence = { date };
    while (Date.now() < deadline) {
      const candidates = (await Promise.all(responses)).filter(Array.isArray);
      if (!candidates.length) throw new Error("抖音数据接口未返回有效统计结果");
      const usable = candidates.filter((starts) =>
        starts.every((start) => calendarStartMatches(start, date)),
      );
      if (!usable.length) throw new Error("日期筛选响应不匹配，未写入");
      const state = await page.evaluate((panel) => {
        const visible = (e) =>
          e.getClientRects().length > 0 &&
          getComputedStyle(e).visibility !== "hidden";
        const root = [...document.querySelectorAll(panel)].find(visible);
        if (!root) return { starts: [], empty: false, loading: true };
        const cards = [
          ...root.querySelectorAll(".record-list .record-card"),
        ].filter(visible);
        return {
          starts: cards.map(
            (card) =>
              card.innerText
                .replace(/\s+/g, " ")
                .match(
                  /开播\s*时间[：:]\s*(\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2})/,
                )?.[1] || null,
          ),
          empty: !cards.length && root.innerText.includes("暂无内容"),
          loading: [...root.querySelectorAll(".semi-spin-spinning")].some(
            visible,
          ),
        };
      }, LIVE_PANEL);
      this.calendarEvidence = {
        date,
        responseStarts: candidates.map((s) => s.slice(0, 50)),
        displayedStarts: state.starts.slice(0, 50),
        loading: state.loading,
      };
      if (
        !state.loading &&
        usable.some((starts) =>
          starts.length
            ? state.starts.length > 0 &&
              state.starts.every((start) => start && starts.includes(start))
            : state.empty && !(expectedCount > 0),
        )
      )
        return;
      await pause(250);
    }
    throw new Error("场次列表加载未完成或与接口不一致，请重试");
  }
  async waitForData(page) {
    const tracker = this.dataRequests.get(page);
    if (!tracker) return;
    const started = Date.now();
    while (Date.now() - started < 25000) {
      if (tracker.errors.length) throw new Error(tracker.errors[0]);
      if (
        !tracker.pending.size &&
        Date.now() - Math.max(started, tracker.changed) >= 500
      )
        return;
      await pause(100);
    }
    throw new Error("当前场次数据加载超时，请稍后重试");
  }
  async scanCards(page) {
    const seen = new Map();
    let stable = 0;
    let previous = "";
    for (let turn = 0; turn < 100; turn++) {
      const state = await page.evaluate((panel) => {
        const visible = (e) =>
          e.getClientRects().length > 0 &&
          getComputedStyle(e).visibility !== "hidden";
        const root = [...document.querySelectorAll(panel)].find(visible);
        const list = root?.querySelector(".record-list");
        if (!list)
          return {
            cards: [],
            bottom: true,
            height: 0,
            missing: true,
            empty: root?.innerText.includes("暂无内容"),
          };
        const cards = [...list.querySelectorAll(".record-card")]
          .filter(visible)
          .map((e) => ({
            text: e.innerText,
            key: e.querySelector(".details")?.innerText,
          }));
        return {
          cards,
          bottom: list.scrollTop + list.clientHeight >= list.scrollHeight - 3,
          height: list.scrollHeight,
          empty: false,
        };
      }, LIVE_PANEL);
      if (state.empty) return [];
      if (state.missing)
        throw new Error("开播场次列表结构发生变化，未标记该日完成");
      for (const c of state.cards) {
        const start = c.text
          .replace(/\s+/g, " ")
          .match(
            /开播\s*时间[：:]\s*(\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2})/,
          )?.[1];
        const ongoing = /(?:^|\n)\s*(?:直播中|正在直播)\s*(?:\n|$)/.test(
          c.text,
        );
        if (!start || (!c.key && !ongoing))
          throw new Error("场次列表结构变化，停止采集");
        const listedDuration = c.text
          .match(/开播\s*时长[：:]\s*([^\n]+)/)?.[1]
          ?.trim();
        const key = c.key || start;
        seen.set(start, { key, start, listedDuration, ongoing });
      }
      const signature = JSON.stringify([seen.size, state.height]);
      stable = signature === previous && state.bottom ? stable + 1 : 0;
      if (stable >= 3) return [...seen.values()];
      previous = signature;
      await page
        .locator(`${LIVE_PANEL}:visible .record-list`)
        .evaluate(
          (e) =>
            (e.scrollTop = Math.min(
              e.scrollTop + e.clientHeight - 30,
              e.scrollHeight,
            )),
        )
        .catch(() => {});
      await pause(1000);
      await this.waitForData(page);
    }
    throw new Error("场次列表未完整加载，未标记该日完成");
  }
  async selectCard(page, card) {
    const list = page.locator(`${LIVE_PANEL}:visible .record-list`);
    await list.evaluate((e) => {
      e.scrollTop = 0;
    });
    for (let i = 0; i < 100; i++) {
      const records = page.locator(
        `${LIVE_PANEL}:visible .record-card:visible`,
      );
      const texts = await records.allInnerTexts();
      const matches = texts
        .map((text, index) => ({
          index,
          start: text
            .replace(/\s+/g, " ")
            .match(
              /开播\s*时间[：:]\s*(\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2})/,
            )?.[1],
        }))
        .filter((r) => r.start === card.start);
      if (matches.length > 1)
        throw new Error("场次开播时间重复，无法确认所选场次");
      const index = matches[0]?.index ?? -1;
      if (index >= 0) {
        await records.nth(index).getByText("查看复盘", { exact: true }).click();
        return;
      }
      const moved = await page
        .locator(`${LIVE_PANEL}:visible .record-list`)
        .evaluate((e) => {
          const old = e.scrollTop;
          e.scrollTop += e.clientHeight - 30;
          return e.scrollTop !== old;
        });
      if (!moved) break;
      await pause(600);
      await this.waitForData(page);
    }
    throw new Error("无法重新定位场次，未标记该日完成");
  }
  async collectAccount(account, from, to, source) {
    const run = this.store.startRun(account.id, from, to, source);
    let count = 0;
    let ongoingCount = 0;
    let loginChecked = false;
    this.store.updateAccount(account.id, { status: "syncing", error: "" });
    try {
      this.context = await this.launch(account.id);
      const page = this.context.pages()[0] || (await this.context.newPage());
      this.responseSummary = [];
      page.on("response", async (response) => {
        if (!["xhr", "fetch"].includes(response.request().resourceType()))
          return;
        const url = new URL(response.url());
        if (
          !url.hostname.endsWith("douyin.com") ||
          !DATA_PATHS.has(url.pathname)
        )
          return;
        const summary = { path: url.pathname, status: response.status() };
        this.responseSummary.push(summary);
        if (response.headers()["content-type"]?.includes("json")) {
          const body = await response.json().catch(() => null);
          if (body && typeof body === "object") {
            summary.keys = Object.keys(body);
            summary.dataKeys =
              body.data && typeof body.data === "object"
                ? Object.keys(body.data).slice(0, 40)
                : [];
          }
        }
      });
      for (const date of datesBetween(from, to)) {
        if (this.stopping) throw new Error("同步已停止");
        this.progress = {
          accountId: account.id,
          handle: account.handle,
          date,
          message: loginChecked ? "读取场次列表" : "检测登录并读取场次列表",
        };
        await this.openDate(
          page,
          date,
          loginChecked
            ? null
            : async () => {
                await this.verifySyncLogin(page, account);
                loginChecked = true;
              },
        );
        const nick = await this.nickname(page);
        const conflict = this.identityConflict(account, page);
        if (conflict) throw new LoginRequired(conflict);
        if (
          !account.douyin_uid &&
          account.nickname &&
          nick !== account.nickname
        )
          throw new LoginRequired("登录昵称与绑定记录不同，请核对账号");
        const handle = await this.publicHandle(page);
        if (handle)
          this.store.updateAccount(account.id, { douyin_handle: handle });
        const cards = await this.scanCards(page);
        const records = [];
        for (const card of cards) {
          if (this.stopping) throw new Error("同步已停止");
          if (!calendarStartMatches(card.start, date))
            throw new Error("日期筛选结果不匹配，未写入");
          if (card.ongoing) {
            ongoingCount++;
            continue;
          }
          this.progress = {
            ...this.progress,
            message: `读取第 ${records.length + 1}/${cards.length} 场`,
          };
          if (records.length) await this.openDate(page, date);
          await this.selectCard(page, card);
          await page.waitForURL((u) => u.searchParams.has("roomId"), {
            timeout: 20000,
          });
          await page.waitForFunction(
            (start) =>
              [...document.querySelectorAll(".basic-time-value")].some(
                (e) => e.textContent.trim() === start,
              ),
            card.start,
            { timeout: 20000 },
          );
          const roomId = new URL(page.url()).searchParams.get("roomId");
          await this.waitForData(page);
          const record = await readDetails(page, roomId, card.listedDuration);
          if (record.start !== card.start) throw new Error("场次切换尚未完成");
          if (record.date > date || record.end.slice(0, 10) < date)
            throw new Error("场次起止时间与所选日期不匹配，未写入");
          records.push(record);
        }
        if (
          new Set(records.map((s) => s.roomId)).size !==
          cards.filter((c) => !c.ongoing).length
        )
          throw new Error("场次出现重复，未标记该日完成");
        this.store.saveDay(
          account.id,
          date,
          records,
          !cards.some((c) => c.ongoing),
          true,
        );
        count += records.length;
      }
      this.store.updateAccount(account.id, {
        status: "ready",
        last_sync: new Date().toISOString(),
        error: "",
      });
      this.store.endRun(
        run,
        "success",
        `已${to >= chinaDate() || ongoingCount ? "更新" : "核对"} ${datesBetween(from, to).length} 天${ongoingCount ? `，${ongoingCount} 场直播中，等待复盘` : ""}`,
        count,
      );
      await mkdir(path.join(this.dataDir, "diagnostics"), { recursive: true });
      await writeFile(
        path.join(this.dataDir, "diagnostics", `${run}-requests.json`),
        JSON.stringify(this.responseSummary, null, 2),
      );
    } catch (e) {
      const diagnosticDir = path.join(this.dataDir, "diagnostics");
      await mkdir(diagnosticDir, { recursive: true });
      const currentPage = this.context?.pages()[0];
      const diagnostic = {
        account: { id: account.id, nickname: account.nickname },
        step: this.progress?.message,
        date: this.progress?.date,
        error: e.message,
        stack: e.stack?.split("\n").slice(0, 8),
        responses: this.responseSummary,
        calendar: this.calendarEvidence,
      };
      await writeFile(
        path.join(diagnosticDir, `${run}.json`),
        JSON.stringify(diagnostic, null, 2),
      );
      if (
        currentPage &&
        (!this.store.retentionEnabled ||
          this.progress?.date >= retentionStart()) &&
        new URL(currentPage.url()).pathname.startsWith("/anchor")
      )
        await currentPage
          .screenshot({ path: path.join(diagnosticDir, `${run}.png`) })
          .catch(() => {});
      const message =
        e instanceof LoginRequired
          ? e.message
          : e.message.startsWith("locator.") || e.message.includes("Timeout")
            ? "页面加载超时或结构发生变化，请重试并检查登录状态"
            : e.message.slice(0, 220);
      if (e instanceof LoginRequired && !e.loginResult)
        this.store.saveLoginCheck(
          account.id,
          "expired",
          `同步检测：${message}`,
        );
      else if (!loginChecked && !e.loginResult && !this.stopping)
        this.store.saveLoginCheck(
          account.id,
          "unknown",
          "同步检测：页面未能就绪，暂时无法确认登录状态",
        );
      this.store.updateAccount(account.id, {
        status:
          e instanceof LoginRequired ? e.loginResult || "expired" : "error",
        error: message,
      });
      this.store.endRun(run, "error", message, count);
    } finally {
      await this.context?.close().catch(() => {});
      this.context = null;
    }
  }
  startSync({ accountId, anchorId, from, to, source = "manual" } = {}) {
    if (
      this.busy ||
      this.exporting ||
      this.checking ||
      this.bindings.size >= this.maxBrowsers ||
      (accountId && this.bindings.has(accountId))
    )
      throw new Error("已有同步或登录任务，请稍后再试");
    const accounts = this.store
      .listAccounts()
      .filter(
        (a) =>
          a.enabled &&
          !this.bindings.has(a.id) &&
          a.approval === "approved" &&
          (!anchorId || a.anchor_id === anchorId) &&
          (!accountId || a.id === accountId) &&
          ![
            "unbound",
            "binding",
            "expired",
            "verification",
            "mismatch",
          ].includes(a.status),
      );
    if (!accounts.length) throw new Error("没有可同步的账号，请先扫码绑定");
    if (from || to) {
      validateCollectionRange(from, to);
    }
    this.busy = true;
    this.syncAccountId = accountId || null;
    this.stopping = false;
    this.task = (async () => {
      try {
        for (const account of accounts) {
          if (this.stopping) break;
          const ranges =
            from && source === "manual"
              ? [{ from, to }]
              : this.store.automaticRanges(account.id, chinaDate(), {
                  from:
                    from ||
                    (source === "scheduled"
                      ? undefined
                      : `${chinaDate().slice(0, 7)}-01`),
                  to,
                });
          for (const range of ranges) {
            if (this.stopping) break;
            await this.collectAccount(account, range.from, range.to, source);
            if (this.store.account(account.id).status !== "ready") break;
          }
        }
      } finally {
        this.busy = false;
        this.syncAccountId = null;
        this.progress = null;
      }
    })();
    return { started: true, accounts: accounts.length };
  }
  async close() {
    this.stopping = true;
    await this.exportTask?.catch(() => {});
    for (const id of [...this.bindings.keys()]) await this.cancelBinding(id);
    await this.context?.close().catch(() => {});
    await this.checkContext?.close().catch(() => {});
    await this.checkTask;
    await this.task;
  }
}
