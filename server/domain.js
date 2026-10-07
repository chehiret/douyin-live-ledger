import { readCount, aggregateLabels } from "../shared/metrics.js";
const DAY = 86400000;
export function chinaDate(now = new Date()) {
  return new Date(now.getTime() + 8 * 3600000).toISOString().slice(0, 10);
}
export function shiftDate(date, days) {
  return new Date(
    Date.parse(`${date}T00:00:00+08:00`) + days * DAY + 8 * 3600000,
  )
    .toISOString()
    .slice(0, 10);
}
// Reporting and retention both use Shanghai calendar months: current + previous two.
export function retentionStart(today = chinaDate()) {
  const [year, month] = today.split("-").map(Number);
  return new Date(Date.UTC(year, month - 3, 1)).toISOString().slice(0, 10);
}
export function validateCollectionRange(from, to, today = chinaDate()) {
  datesBetween(from, to);
  if (from < "2020-01-01" || to > today)
    throw new Error(
      "请选择2020年以后、截至今天的日期；历史数据以抖音实际可查询范围为准",
    );
}
export function validDate(date) {
  return (
    typeof date === "string" &&
    /^\d{4}-\d{2}-\d{2}$/.test(date) &&
    Number.isFinite(Date.parse(date)) &&
    new Date(`${date}T00:00:00Z`).toISOString().slice(0, 10) === date
  );
}
export function monthRange(month) {
  if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(month || ""))
    throw new Error("请选择有效月份");
  const [year, m] = month.split("-").map(Number);
  if (year < 2020 || year > 2100) throw new Error("月份超出范围");
  return {
    from: `${month}-01`,
    to: `${month}-${new Date(Date.UTC(year, m, 0)).getUTCDate()}`,
  };
}
export function datesBetween(from, to) {
  if (!validDate(from) || !validDate(to) || from > to)
    throw new Error("日期范围不正确");
  const days = Math.round((Date.parse(to) - Date.parse(from)) / DAY) + 1;
  if (days > 100) throw new Error("一次最多查询100天");
  return Array.from({ length: days }, (_, i) => shiftDate(from, i));
}
export function exactCount(value, label = "指标") {
  const str = String(value ?? "").replace(/[,，\s]/g, "");
  if (!/^\d+$/.test(str))
    throw new Error(`${label}不是精确整数，未计入统计：${str.slice(0, 24)}`);
  const n = Number(str);
  if (!Number.isSafeInteger(n)) throw new Error(`${label}超出范围`);
  return n;
}
export function durationSeconds(value) {
  const s = String(value).replace(/\s/g, "");
  if (!s || !/^(?:(\d+)(?:小时|时))?(?:(\d+)(?:分钟|分))?(?:(\d+)秒)?$/.test(s))
    throw new Error("无法读取精确直播时长");
  const match = s.match(
    /^(?:(\d+)(?:小时|时))?(?:(\d+)(?:分钟|分))?(?:(\d+)秒)?$/,
  );
  const n =
    Number(match[1] || 0) * 3600 +
    Number(match[2] || 0) * 60 +
    Number(match[3] || 0);
  if (!Number.isSafeInteger(n)) throw new Error("直播时长超出范围");
  return n;
}
export function exactPercent(value) {
  const str = String(value ?? "").replace(/\s/g, "");
  if (!/^\d+(?:\.\d+)?[%％]$/.test(str))
    throw new Error("进房率不是有效百分比");
  const n = Number(str.slice(0, -1));
  if (!Number.isFinite(n) || n < 0 || n > 100)
    throw new Error("进房率超出范围");
  return n;
}
export function trafficTotals(rows) {
  const total = (key) =>
    rows.some((s) => s[key] == null)
      ? null
      : rows.reduce((n, s) => n + s[key], 0);
  const exposure = total("exposure"),
    entrants = total("entrants");
  const labels = aggregateLabels(rows);
  if ((labels.exposure || labels.entrants) && exposure > 0 && entrants != null)
    labels.entry_rate = `约${Number(((entrants / exposure) * 100).toFixed(2))}%`;
  return {
    ...(Object.keys(labels).length ? { count_labels: labels } : {}),
    exposure,
    entrants,
    entry_rate:
      exposure == null || entrants == null
        ? null
        : exposure === 0
          ? entrants === 0
            ? 0
            : null
          : (entrants / exposure) * 100,
  };
}
export function parseSession(raw) {
  if (!/^\d{10,30}$/.test(String(raw.roomId || "")))
    throw new Error("缺少有效场次ID");
  const start = raw.start?.trim(),
    end = raw.end?.trim();
  const stamp = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/;
  if (
    !stamp.test(start || "") ||
    !stamp.test(end || "") ||
    !validDate(start.slice(0, 10)) ||
    !validDate(end.slice(0, 10))
  )
    throw new Error("直播时间尚未完整，稍后重试");
  const elapsed =
    (Date.parse(end.replace(" ", "T") + "+08:00") -
      Date.parse(start.replace(" ", "T") + "+08:00")) /
    1000;
  // A zero-second broadcast can have blank detail text, but both other sources must confirm zero.
  const confirmedZero =
    !String(raw.duration ?? "").trim() &&
    elapsed === 0 &&
    String(raw.listedDuration ?? "").replace(/\s/g, "") === "0秒";
  const duration = confirmedZero ? 0 : durationSeconds(raw.duration);
  if (!Number.isFinite(elapsed) || elapsed < 0 || duration > elapsed + 60)
    throw new Error("直播起止时间与时长不一致");
  const counts = {},
    labels = {};
  for (const [key, label] of Object.entries({
    followers: "新增粉丝",
    gifters: "送礼人数",
    fanclub: "加粉丝团人数",
    commenters: "评论人数",
    exposure: "曝光人数",
    entrants: "进房人数",
  })) {
    if (raw[key] == null && !["followers", "gifters"].includes(key)) {
      counts[key] = null;
      continue;
    }
    const parsed = readCount(raw[key], label);
    counts[key] = parsed.value;
    if (parsed.label) labels[key] = parsed.label;
  }
  return {
    roomId: String(raw.roomId),
    title: String(raw.title || "").slice(0, 250),
    start,
    end,
    date: start.slice(0, 10),
    duration,
    ...counts,
    count_labels: labels,
    entry_rate: raw.entry_rate == null ? null : exactPercent(raw.entry_rate),
  };
}
export function csvCell(value) {
  let s = String(value ?? "");
  if (/^[=+@\-\t\r]/.test(s)) s = "'" + s;
  return '"' + s.replaceAll('"', '""') + '"';
}
export function scheduleDue(settings, now = new Date()) {
  const local = new Date(now.getTime() + 8 * 3600000);
  const date = local.toISOString().slice(0, 10);
  const mins = local.getUTCHours() * 60 + local.getUTCMinutes();
  const [h, m] = settings.time.split(":").map(Number);
  return settings.enabled && settings.lastDate !== date && mins >= h * 60 + m;
}
export function realtimeDue(settings, now = new Date()) {
  return (
    settings.enabled &&
    settings.realtimeEnabled &&
    (!settings.lastRealtimeAt ||
      now.getTime() - Date.parse(settings.lastRealtimeAt) >=
        settings.intervalMinutes * 60000)
  );
}
