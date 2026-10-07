import test from "node:test";
import assert from "node:assert/strict";
import { Store } from "../server/store.js";
import {
  chinaDate,
  monthRange,
  datesBetween,
  parseSession,
  exactCount,
  durationSeconds,
  csvCell,
  scheduleDue,
  trafficTotals,
  exactPercent,
} from "../server/domain.js";

function fixture() {
  const store = new Store(":memory:");
  const a = store.saveAnchor({ name: "主播甲", note: "双账号" }),
    b = store.saveAnchor({ name: "主播乙" });
  const one = store.createAccount({ anchorId: a.id, handle: "one" }),
    two = store.createAccount({ anchorId: a.id, handle: "two" });
  return { store, a, b, one, two };
}
function session(
  roomId = "7664998569060993807",
  date = "2026-07-21",
  duration = 4,
  followers = 0,
  gifters = 0,
) {
  return {
    roomId,
    date,
    title: "直播",
    start: `${date} 23:09:25`,
    end: `${date} 23:09:29`,
    duration,
    followers,
    gifters,
  };
}
test("natural month includes leap day and year boundary in China time", () => {
  assert.deepEqual(monthRange("2024-02"), {
    from: "2024-02-01",
    to: "2024-02-29",
  });
  assert.equal(datesBetween("2026-12-01", "2026-12-31").length, 31);
  assert.equal(chinaDate(new Date("2026-08-31T16:00:00Z")), "2026-09-01");
  assert.throws(() => monthRange("2026-13"));
  assert.throws(() => datesBetween("2026-02-30", "2026-03-01"));
});
test("counts fail closed for missing, rounded and malformed numbers", () => {
  assert.equal(exactCount("1,234"), 1234);
  assert.equal(exactCount("0"), 0);
  for (const v of [null, "", "--", "1.2万", "-2", "NaN"])
    assert.throws(() => exactCount(v));
  assert.equal(durationSeconds("1小时2分钟8秒"), 3728);
  assert.equal(durationSeconds("0秒"), 0);
  assert.throws(() => durationSeconds(""));
});
test("session IDs remain strings and cross-midnight belongs to start date", () => {
  const s = parseSession({
    roomId: "7664998569060993807",
    start: "2026-08-31 23:59:00",
    end: "2026-09-01 00:01:00",
    duration: "2分钟",
    followers: "12",
    gifters: "3",
  });
  assert.equal(s.roomId, "7664998569060993807");
  assert.equal(s.date, "2026-08-31");
  assert.equal(s.duration, 120);
  assert.throws(() =>
    parseSession({
      ...s,
      roomId: 123,
      start: s.start,
      end: s.end,
      duration: "2分钟",
    }),
  );
});
test("multiple sessions and accounts aggregate without duplicate sync accumulation", () => {
  const { store, a, one, two } = fixture();
  const records = [
    session("7664998569060993807", "2026-07-21", 4, 2, 1),
    session("7664990246752275200", "2026-07-21", 11, 3, 2),
  ];
  store.saveDay(one.id, "2026-07-21", records);
  store.saveDay(one.id, "2026-07-21", records);
  store.saveDay(two.id, "2026-07-21", [
    session("7664990246752275211", "2026-07-21", 3600, 5, 2),
  ]);
  let report = store.report("2026-07", a.id, "", "2026-09-06");
  assert.deepEqual(report.totals, {
    exposure: null,
    entrants: null,
    entry_rate: null,
    fanclub: null,
    commenters: null,
    duration: 3615,
    followers: 10,
    gifters: 5,
    sessions: 3,
  });
  assert.equal(
    report.daily.find((d) => d.date === "2026-07-21").state,
    "complete",
  );
  records[0].followers = 4;
  store.saveDay(one.id, "2026-07-21", records);
  assert.equal(store.report("2026-07").totals.followers, 12);
  store.close();
});
test("interaction metrics preserve unknown history and update every session without double counting", () => {
  const { store, one, two, a } = fixture();
  try {
    const records = [
      session("7664998569060993807"),
      session("7664998569060993808"),
    ];
    store.saveDay(one.id, "2026-07-21", records);
    assert.equal(store.report("2026-07", a.id).totals.fanclub, null);
    const updated = records.map((s, i) => ({
      ...s,
      fanclub: i + 2,
      commenters: i + 5,
    }));
    store.saveDay(one.id, "2026-07-21", updated);
    store.saveDay(one.id, "2026-07-21", updated);
    store.saveDay(two.id, "2026-07-21", [
      { ...session("7664998569060993809"), fanclub: 0, commenters: 3 },
    ]);
    const r = store.report("2026-07", a.id);
    assert.equal(r.totals.fanclub, 5);
    assert.equal(r.totals.commenters, 14);
    assert.equal(r.allTime.commenters, 14);
    assert.equal(r.daily.find((d) => d.date === "2026-07-21").fanclub, 5);
    assert.equal(r.sessions.length, 3);
    store.saveDay(one.id, "2026-07-21", records);
    assert.equal(store.report("2026-07", a.id).totals.fanclub, 5);
  } finally {
    store.close();
  }
});
test("traffic metrics keep official session rates and use weighted aggregate rates", () => {
  assert.equal(exactPercent("12.50 %"), 12.5);
  for (const bad of ["--", "12.5", "101%", "NaN%", "-1%", ""])
    assert.throws(() => exactPercent(bad));
  const { store, one, a } = fixture();
  try {
    const rows = [
      { ...session(), exposure: 100, entrants: 50, entry_rate: 50 },
      {
        ...session("7664998569060993808"),
        exposure: 900,
        entrants: 90,
        entry_rate: 10,
      },
    ];
    store.saveDay(one.id, "2026-07-21", rows);
    store.saveDay(one.id, "2026-07-21", rows);
    const r = store.report("2026-07", a.id);
    assert.equal(r.totals.exposure, 1000);
    assert.equal(r.totals.entrants, 140);
    assert.ok(Math.abs(r.totals.entry_rate - 14) < 1e-9);
    assert.equal(r.allTime.entry_rate, r.totals.entry_rate);
    assert.equal(
      r.sessions.find((s) => s.room_id === rows[1].roomId).entry_rate,
      10,
    );
    assert.equal(trafficTotals([{ exposure: 0, entrants: 0 }]).entry_rate, 0);
    assert.equal(
      trafficTotals([{ exposure: null, entrants: 0 }]).entry_rate,
      null,
    );
  } finally {
    store.close();
  }
});
test("global session ID prevents linking the same broadcast under two accounts", () => {
  const { store, one, two } = fixture();
  store.saveDay(one.id, "2026-07-21", [session()]);
  assert.throws(
    () => store.saveDay(two.id, "2026-07-21", [session()]),
    /另一个抖音号/,
  );
  assert.equal(store.report("2026-07").sessions.length, 1);
  assert.equal(store.report("2026-07").coverage.length, 1);
  store.close();
});
test("incomplete enumeration is atomic and never overwrites stored day with zero", () => {
  const { store, one } = fixture();
  store.saveDay(one.id, "2026-07-21", [session()]);
  assert.throws(() => store.saveDay(one.id, "2026-07-21", []), /不一致/);
  assert.equal(store.report("2026-07").totals.duration, 4);
  store.close();
});
test("missing days, checked zero days and pending days remain distinguishable", (t) => {
  t.mock.timers.enable({ apis: ["Date"], now: Date.parse("2026-09-06T00:00:00Z") });
  const { store, one, two } = fixture();
  store.saveDay(one.id, "2026-09-01", []);
  let report = store.report("2026-09", "", "", "2026-09-06");
  assert.equal(report.daily[0].state, "partial");
  assert.equal(report.daily[1].state, "missing");
  assert.equal(report.daily[5].state, "provisional");
  store.saveDay(two.id, "2026-09-01", []);
  report = store.report("2026-09", "", "", "2026-09-06");
  assert.equal(report.daily[0].state, "complete");
  store.close();
});
test("account reassignment moves its historical totals once, month filter remains exact", () => {
  const { store, a, b, one } = fixture();
  store.saveDay(one.id, "2026-07-31", [
    session("7664998569060993807", "2026-07-31", 900),
  ]);
  store.saveDay(one.id, "2026-08-01", [
    session("7664998569060993808", "2026-08-01", 100),
  ]);
  store.updateAccount(one.id, { anchor_id: b.id });
  assert.equal(store.report("2026-07", a.id).totals.duration, 0);
  assert.equal(store.report("2026-07", b.id).totals.duration, 900);
  assert.equal(store.report("2026-08", b.id).totals.duration, 100);
  assert.equal(store.report("2026-08", b.id).allTime.duration, 1000);
  store.close();
});
test("scheduler uses Shanghai clock and backfills month-end on day one", () => {
  const settings = { enabled: true, time: "04:00", lastDate: null };
  assert.equal(scheduleDue(settings, new Date("2026-08-31T19:59:00Z")), false);
  assert.equal(scheduleDue(settings, new Date("2026-08-31T20:00:00Z")), true);
  assert.equal(
    scheduleDue(
      { ...settings, lastDate: "2026-09-01" },
      new Date("2026-08-31T20:00:00Z"),
    ),
    false,
  );
  const { store, one } = fixture();
  store.updateAccount(one.id, { tracking_from: "2026-08-31" });
  assert.deepEqual(store.automaticRange(one.id, "2026-09-01"), {
    from: "2026-08-31",
    to: "2026-09-01",
  });
  store.close();
});
test("blank duration requires both explicit zero list value and identical start/end", () => {
  const raw = {
    roomId: "7664998569060993807",
    start: "2026-07-15 19:32:06",
    end: "2026-07-15 19:32:06",
    duration: "",
    followers: "0",
    gifters: "0",
  };
  assert.equal(parseSession({ ...raw, listedDuration: "0秒" }).duration, 0);
  assert.throws(() => parseSession(raw));
  assert.throws(() =>
    parseSession({ ...raw, listedDuration: "0秒", end: "2026-07-15 19:33:06" }),
  );
});
test("CSV blocks formula injection and preserves quotes", () => {
  assert.equal(csvCell('=HYPERLINK("x")'), '"\'=HYPERLINK(""x"")"');
  assert.equal(csvCell("a,b"), '"a,b"');
});
