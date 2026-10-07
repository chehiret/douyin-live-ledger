import test from "node:test";
import assert from "node:assert/strict";
import { chromium } from "playwright";
import { Store } from "../server/store.js";
import {
  Collector,
  REVIEW,
  LoginRequired,
  loginChallenge,
} from "../server/collector.js";

test(
  "scroll enumeration loads later batches; detail records persist without duplicates",
  { timeout: 90000 },
  async () => {
    const browser = await chromium.launch({
      headless: true,
      channel: process.platform === "win32" ? "msedge" : undefined,
    });
    const context = await browser.newContext();
    const page = await context.newPage();
    const store = new Store(":memory:");
    const a = store.saveAnchor({ name: "测试" }),
      account = store.createAccount({
        anchorId: a.id,
        handle: "collector-fixture",
      });
    const collector = new Collector(store, "unused");
    try {
      await page.setContent(`<div class="semi-modal-body"><div id="semiTabPanel1" style="display:none"><div>暂无内容</div><div class="record-list"><div class="record-card"><div class="details">错误的隐藏场次</div></div></div></div><div id="semiTabPanel0"><div class="record-list" style="height:250px;overflow:auto"></div></div></div><script>
      let loaded=0;const list=document.querySelector('#semiTabPanel0 .record-list');
      function more(){for(let i=0;i<3&&loaded<9;i++,loaded++){const el=document.createElement('div');el.className='record-card';el.style.height='125px';el.innerHTML='<div class="details">直播 '+loaded+'<div class="jump">查看复盘</div>开播时间：2026-09-05 12:'+String(loaded).padStart(2,'0')+':00<br>开播时长：1分钟</div>';list.appendChild(el);}}
      more();list.addEventListener('scroll',()=>{if(list.scrollTop+list.clientHeight>=list.scrollHeight-35)setTimeout(more,200)});
    </script>`);
      const cards = await collector.scanCards(page);
      assert.equal(cards.length, 9);
      assert.equal(cards.at(-1).start, "2026-09-05 12:08:00");
      await page.setContent(
        '<div class="semi-modal-body"><div id="semiTabPanel0"><div>暂无内容</div></div></div>',
      );
      assert.deepEqual(await collector.scanCards(page), []);
      await page.setContent('<div class="semi-modal-body"><div id="semiTabPanel0"><div class="record-list"><div class="record-card"><div>直播中</div><div>开播时间：2026-09-05 12:00:00</div></div></div></div></div>');
      const ongoing = await collector.scanCards(page);
      assert.equal(ongoing.length, 1);
      assert.equal(ongoing[0].ongoing, true);
      await page.setContent(
        '<div class="semi-modal-body"><div id="semiTabPanel0"><div class="record-list"><div class="record-card"><div class="details">invalid</div></div></div></div></div>',
      );
      await assert.rejects(() => collector.scanCards(page), /结构变化/);
      await context.route("https://anchor.douyin.com/**", (route) =>
        route.fulfill({ contentType: "text/html", body: "<p>扫码登录</p>" }),
      );
      await page.goto("https://anchor.douyin.com/login");
      await assert.rejects(() => collector.checkLogin(page), LoginRequired);
      await page.setContent("<p>验证码登录 获取验证码 密码登录</p>");
      assert.equal(await loginChallenge(page), null);
      await page.setContent(
        '<iframe srcdoc="<p>为了账号安全，请完成身份验证</p>"></iframe>',
      );
      assert.equal(await loginChallenge(page), "verification");
      await page.setContent("<p>扫码成功，请在手机上确认</p>");
      assert.equal(await loginChallenge(page), "scanned");
      await page.setContent(
        '<p>扫码成功</p><iframe srcdoc="<p>请完成身份验证</p>"></iframe>',
      );
      assert.equal(await loginChallenge(page), "verification");
      assert.equal(store.report("2026-09").coverage.length, 0);
    } finally {
      store.close();
      await browser.close();
    }
  },
);
