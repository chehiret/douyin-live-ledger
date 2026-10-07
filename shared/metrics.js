export const countKeys = [
  "followers",
  "gifters",
  "fanclub",
  "commenters",
  "exposure",
  "entrants",
];

export function metricLabels(row) {
  const labels = row?.count_labels;
  if (typeof labels === "string") {
    try {
      return JSON.parse(labels) || {};
    } catch {
      return {};
    }
  }
  return labels || {};
}

export function readCount(value, name = "人数") {
  const text = String(value ?? "").replace(/[,，\s]/g, "");
  const match = text.match(/^(约)?(\d+(?:\.\d+)?)(千|万|亿)?$/);
  if (!match || (!match[1] && !match[3] && text.includes(".")))
    throw new Error(`${name}无法读取：${text.slice(0, 24)}`);
  const valueNumber =
    Number(match[2]) * ({ 千: 1000, 万: 10000, 亿: 100000000 }[match[3]] || 1);
  const rounded = Math.round(valueNumber);
  if (
    !Number.isSafeInteger(rounded) ||
    Math.abs(valueNumber - rounded) > 0.000001
  )
    throw new Error(`${name}超出范围或格式无效`);
  return {
    value: rounded,
    label: match[1] || match[3] ? `约${match[2]}${match[3] || ""}` : null,
  };
}

export function approximateText(n) {
  const unit = n >= 100000000 ? "亿" : n >= 10000 ? "万" : "";
  const divisor = unit === "亿" ? 100000000 : unit === "万" ? 10000 : 1;
  return `约${new Intl.NumberFormat("zh-CN", { maximumFractionDigits: 2 }).format(n / divisor)}${unit}`;
}

export function metricText(row, key) {
  if (row?.[key] == null) return "未采集";
  return (
    metricLabels(row)[key] ||
    `${new Intl.NumberFormat("zh-CN", { maximumFractionDigits: 2 }).format(row[key])}${key === "entry_rate" ? "%" : ""}`
  );
}

export function aggregateLabels(rows) {
  const labels = {};
  for (const key of countKeys) {
    if (
      rows.some((row) => metricLabels(row)[key]) &&
      rows.every((row) => row[key] != null)
    )
      labels[key] = approximateText(
        rows.reduce((sum, row) => sum + row[key], 0),
      );
  }
  return labels;
}
