// Pure formatting utilities — no DOM, no state dependencies

function round2(x) { return Math.round(Number(x || 0) * 100) / 100; }

function fmtCurrency(n) {
  const v = Number(n || 0);
  return v.toLocaleString(undefined, {
    style: "currency",
    currency: APP_CURRENCY,
    maximumFractionDigits: 0,
    minimumFractionDigits: 0,
  });
}

function setAppCurrency(currencyCode) {
  const next = String(currencyCode || "").trim().toUpperCase();
  if (next) APP_CURRENCY = next;
}

function formatDelta(v, asCurrency = true) {
  if (!Number.isFinite(v)) return "--";
  const sign = v > 0 ? "+" : (v < 0 ? "-" : "=");
  const abs = Math.abs(v);
  const val = asCurrency ? fmtCurrency(abs) : abs.toFixed(1);
  return sign + " " + val + " vs PM";
}

function formatMonthLabel(monthKey) {
  const parts = String(monthKey || "").split("-");
  if (parts.length !== 2) return "--";
  const year = Number(parts[0]);
  const month = Number(parts[1]);
  if (!year || !month) return "--";
  const dt = new Date(year, month - 1, 1);
  return dt.toLocaleString(undefined, { month: "long", year: "numeric" });
}

function monthInitialLabels(labels) {
  return (labels || []).map(label => {
    const parts = String(label || "").split("-");
    if (parts.length !== 2) return String(label || "").slice(0, 3);
    const year = Number(parts[0]);
    const month = Number(parts[1]);
    if (!Number.isFinite(year) || !Number.isFinite(month) || month < 1 || month > 12) {
      return String(label || "").slice(0, 3);
    }
    const dt = new Date(year, month - 1, 1);
    return dt.toLocaleString(undefined, { month: "short" });
  });
}
