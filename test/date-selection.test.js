import test from "node:test";
import assert from "node:assert/strict";
import { chromium } from "playwright";
import { Collector, REVIEW } from "../server/collector.js";

test("unavailable historical month and day fail explicitly without treating them as empty broadcasts", async () => {
  const browser = await chromium.launch({
    headless: true,
    channel: process.platform === "win32" ? "msedge" : undefined,
  });
  const context = await browser.newContext();
  try {
    await context.route(REVIEW, (route) =>
      route.fulfill({
        contentType: "text/html; charset=utf-8",
        body: '<button>切换场次</button><div class="semi-modal-body"><h5>2026年09月</h5><button disabled>上个月</button><div role="gridcell" aria-label="2026/9/1" aria-disabled="true">1</div></div>',
      }),
    );
    const collector = new Collector(null, "unused"),
      page = await context.newPage();
    await assert.rejects(
      () => collector.openDate(page, "2026-06-01"),
      /不支持查询该历史月份/,
    );
    await assert.rejects(
      () => collector.openDate(page, "2026-09-01"),
      /不支持查询该历史日期/,
    );
  } finally {
    await browser.close();
  }
});

test(
  "date selection ignores duplicate hidden linked panel and background telemetry",
  { timeout: 15000 },
  async () => {
    const browser = await chromium.launch({
      headless: true,
      channel: process.platform === "win32" ? "msedge" : undefined,
    });
    const context = await browser.newContext();
    try {
      let dataFinished = false;
      let invalidData = false;
      const historyPath =
        "/anchor_pc_tinker_proxy/lego/native/webcast_api/room/replay/history_list";
      await context.route("**" + historyPath + "?**", async (route) => {
        await new Promise((r) => setTimeout(r, 1500));
        await route.fulfill({
          contentType: "application/json",
          body: invalidData
            ? '{"code":500,"message":"unavailable"}'
            : '{"code":0,"data":{"series":[]}}',
        });
        dataFinished = true;
      });
      await context.route("**/heartbeat", async (route) => {
        await new Promise((r) => setTimeout(r, 120));
        await route
          .fulfill({ contentType: "application/json", body: "{}" })
          .catch(() => {});
      });
      await context.route(REVIEW, (route) =>
        route.fulfill({
          contentType: "text/html; charset=utf-8",
          body: `
      <button onclick="document.querySelector('.semi-modal-body').hidden=false">切换场次</button>
      <div class="semi-modal-body" hidden><h5>2026年09月</h5>
        <div role="gridcell" aria-label="2026/9/1" onclick="document.querySelectorAll('.date').forEach(e=>e.textContent='2026年09月01日');setTimeout(()=>fetch('${historyPath}?startDate=2026-09-01&endDate=2026-09-01'),900)">1</div>
        <div id="semiTabPanel1" style="display:none"><span class="date">近7日</span><div class="record-list"><div class="record-card">隐藏连线场次</div></div></div>
        <div id="semiTabPanel0"><span class="date">近7日</span><p>暂无内容</p></div>
      </div><script>setInterval(()=>fetch('/heartbeat'),50)</script>`,
        }),
      );
      const page = await context.newPage();
      const collector = new Collector(null, "unused");
      await collector.openDate(page, "2026-09-01");
      assert.equal(dataFinished, true);
      assert.deepEqual(await collector.scanCards(page), []);
      invalidData = true;
      await assert.rejects(
        () => collector.openDate(page, "2026-09-01"),
        /未返回有效统计结果/,
      );
    } finally {
      await browser.close();
    }
  },
);

test(
  "date selection waits for matching rendered cards after delayed requests and rejects wrong dates",
  { timeout: 20000 },
  async () => {
    const browser = await chromium.launch({
      headless: true,
      channel: process.platform === "win32" ? "msedge" : undefined,
    });
    const context = await browser.newContext();
    const historyPath =
      "/anchor_pc_tinker_proxy/lego/native/webcast_api/room/replay/history_list";
    let initialEmpty = false;
    let wrongDate = false;
    try {
      await context.route("**" + historyPath + "?**", (route) =>
        route.fulfill({
          json: {
            data: {
              series: [
                {
                  startTime: wrongDate
                    ? "2026-09-04 12:00:00"
                    : "2026-09-01 12:00:00",
                },
              ],
            },
          },
        }),
      );
      await context.route(REVIEW, (route) =>
        route.fulfill({
          contentType: "text/html; charset=utf-8",
          body: `<button onclick="document.querySelector('.semi-modal-body').hidden=false">切换场次</button>
        <div class="semi-modal-body" hidden><h5>2026年09月</h5>
        <div role="gridcell" aria-label="2026/9/1" onclick="selectDay()">1</div>
        <div id="semiTabPanel0"><span class="date">近7日</span><div class="record-list">${initialEmpty ? "<p>暂无内容</p>" : '<div class="record-card"><div class="details">开播时间：2026-09-04 12:00:00</div></div>'}</div></div></div>
        <script>
          function selectDay(){
            document.querySelector('.date').textContent='2026年09月01日';
            setTimeout(async()=>{
              await fetch('${historyPath}?startDate=2026-09-01&endDate=2026-09-01');
              setTimeout(()=>document.querySelector('.record-list').innerHTML='<div class="record-card"><div class="details">开播时间：2026-09-01 12:00:00</div></div>',1200);
            },900);
          }
        </script>`,
        }),
      );
      const page = await context.newPage();
      const collector = new Collector(null, "unused");
      for (const empty of [false, true]) {
        initialEmpty = empty;
        await collector.openDate(page, "2026-09-01");
        assert.equal(
          await page.locator("#semiTabPanel0 .record-card").innerText(),
          "开播时间：2026-09-01 12:00:00",
        );
      }
      wrongDate = true;
      await assert.rejects(
        () => collector.openDate(page, "2026-09-01"),
        /日期筛选响应不匹配/,
      );
    } finally {
      await browser.close();
    }
  },
);
