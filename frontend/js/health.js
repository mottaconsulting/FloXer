// Health strip and runway visuals

function avgLastNMonths(values, n = 3) {
  const arr = (values || []).filter(v => Number.isFinite(v));
  if (!arr.length) return 0;
  const slice = arr.slice(Math.max(0, arr.length - n));
  return slice.reduce((a, x) => a + x, 0) / slice.length;
}

function computeHealthFromModel(model, liabilitiesRows) {
  const cashBalance = Number(model?.kpis?.cash_balance_live ?? model?.kpis?.cash_balance_proxy ?? 0);
  const cashOutMonthly = (model?.charts?.cashflow?.cashOut || []).map(x => Number(x || 0));
  const avgCashOut = avgLastNMonths(cashOutMonthly, 3);
  const runwayMonths = avgCashOut > 0 ? (cashBalance / avgCashOut) : null;

  const TAX_BUCKETS = new Set(["GST", "PAYG", "SUPER", "INCOME_TAX", "WAGES"]);
  const nextTax = (liabilitiesRows || [])
    .filter(r => TAX_BUCKETS.has(r.bucket) && r.due_date)
    .sort((a, b) => a.due_date - b.due_date)[0];

  let level = "ok";
  let text = "Healthy cash position";

  if (runwayMonths === null) {
    level = "warn";
    text = "Runway unknown (no cash out history yet)";
  } else if (runwayMonths < 1) {
    level = "danger";
    text = "At risk: cash runway under 1 month";
  } else if (runwayMonths < 2) {
    level = "warn";
    text = "Caution: cash runway under 2 months";
  }

  if (nextTax && nextTax.due_in_days !== null && nextTax.due_in_days <= 21) {
    if (level === "ok") level = "warn";
    text = `${text} | ${nextTax.label} due soon`;
  }

  return { level, text, runwayMonths, nextTax };
}

function renderHealthStrip(health) {
  const badge = document.getElementById("healthBadge");
  const txt = document.getElementById("healthText");
  const runway = document.getElementById("healthRunway");
  const nextTax = document.getElementById("healthNextTax");

  if (!badge || !txt || !runway || !nextTax) return;

  if (health.level === "ok") {
    badge.style.background = "#d1fae5";
    badge.style.color = "#065f46";
    badge.textContent = "HEALTHY";
  } else if (health.level === "warn") {
    badge.style.background = "#fff7ed";
    badge.style.color = "#9a3412";
    badge.textContent = "CAUTION";
  } else {
    badge.style.background = "#fee2e2";
    badge.style.color = "#991b1b";
    badge.textContent = "AT RISK";
  }

  txt.textContent = health.text;

  if (health.runwayMonths === null) {
    runway.textContent = "--";
  } else {
    runway.textContent = `${Math.round(health.runwayMonths * 30)} days`;
  }

  if (health.nextTax) {
    const days = health.nextTax.due_in_days;
    const due = health.nextTax.due_date ? health.nextTax.due_date.toLocaleDateString() : "--";
    nextTax.textContent = `${health.nextTax.label} | ${due}${(days !== null ? ` (${days}d)` : "")}`;
  } else {
    nextTax.textContent = "--";
  }
}

function applyRunwayVisuals(runwayMonths) {
  const card = document.getElementById("runwayCard");
  const badge = document.getElementById("runwayRiskBadge");
  const fill = document.getElementById("runwayMeterFill");
  if (!card || !badge || !fill) return;
  card.classList.remove("runway-tone-red", "runway-tone-orange", "runway-tone-yellow", "runway-tone-green");
  badge.classList.remove("watch");
  badge.style.display = "none";
  fill.style.width = "0%";

  if (!Number.isFinite(runwayMonths)) {
    card.classList.add("runway-tone-yellow");
    return;
  }
  const meterWidth = Math.max(8, Math.min(100, (runwayMonths / 12) * 100));
  fill.style.width = `${meterWidth}%`;
  if (runwayMonths < 3) {
    card.classList.add("runway-tone-red");
  } else if (runwayMonths < 6) {
    card.classList.add("runway-tone-orange");
  } else if (runwayMonths <= 12) {
    card.classList.add("runway-tone-yellow");
  } else {
    card.classList.add("runway-tone-green");
  }
  if (runwayMonths < 3) {
    badge.style.display = "inline-block";
    badge.textContent = "HIGH RISK";
  } else if (runwayMonths <= 6) {
    badge.style.display = "inline-block";
    badge.classList.add("watch");
    badge.textContent = "WATCH";
  }
}
