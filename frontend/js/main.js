let currentData = null;
let showingRaw = false;

let JOURNAL_CACHE = null;
let JOURNAL_LINES = null;
let FILTERED_JOURNAL_LINES = null;
let TX_CURRENT_PAGE = 1;
let TX_PAGE_SIZE = 100;
let APP_CURRENCY = "AUD";

const INCOME_TYPES = new Set(["REVENUE"]);   // your org shows REVENUE
const EXPENSE_TYPES = new Set(["EXPENSE"]);  // your org shows EXPENSE
const BANK_TYPES = new Set(["BANK"]);        // your org shows BANK

// ---------- UI helpers ----------
function setLoading(msg) {
  const el = document.getElementById("loading");
  if (!el) return;
  el.textContent = msg || "Loading...";
  el.style.display = "block";
}
function stopLoading() {
  const el = document.getElementById("loading");
  if (el) el.style.display = "none";
}
function showError(msg) {
  const el = document.getElementById("error");
  if (!el) return;
  el.innerText = msg;
  el.style.display = "block";
}
function hideError() {
  const el = document.getElementById("error");
  if (el) el.style.display = "none";
}
function hideAllViews() {
  ["dashboardContainer","transactionsContainer","liabilitiesContainer","budgetContainer","rawOutput"].forEach(id => {
    const el = document.getElementById(id);
    if (el) el.style.display = "none";
  });
  closeTransactionQuickView();
  stopLoading();
  hideError();
}

// ---------- Data helpers ----------
async function getJournals() {
  if (JOURNAL_CACHE) return JOURNAL_CACHE;
  const data = await XeroAPI.fetch_json("/api/journals");
  JOURNAL_CACHE = data?.Journals || [];
  return JOURNAL_CACHE;
}

function flattenJournalLines(journals) {
  const rows = [];

  for (const j of journals || []) {
    const date = j.JournalDate || j.JournalDateString || j.Date || j.DateString;

    const lines = j.JournalLines || j.JournalLineItems || j.Lines || [];
    for (const line of lines) {
      rows.push({
        date,
        journalId: j.JournalID ?? j.JournalId ?? "",
        journalNumber: j.JournalNumber ?? "",
        accountType: line.AccountType ?? line.accountType ?? "",
        accountCode: line.AccountCode ?? line.accountCode ?? "",
        accountName: line.AccountName ?? line.accountName ?? "",
        description: line.Description ?? line.description ?? "",
        net: Number(line.NetAmount ?? line.GrossAmount ?? line.Net ?? 0)
      });
    }
  }
  return rows;
}


function monthKey(dateStr) {
  const d = XeroTables.parseXeroDate(dateStr);
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  return `${y}-${m}`;
}
// --------- Health computation ----------
function avgLastNMonths(values, n = 3) {
  const arr = (values || []).filter(v => Number.isFinite(v));
  if (!arr.length) return 0;
  const slice = arr.slice(Math.max(0, arr.length - n));
  return slice.reduce((a, x) => a + x, 0) / slice.length;
}

function computeHealthFromModel(model, liabilitiesRows) {
  // Use CASH OUT (bank) for runway because itâ€™s closer to real cash burn
  const cashBalance = Number(model?.kpis?.cash_balance_proxy || 0);

  const cashOutMonthly = (model?.charts?.cashflow?.cashOut || []).map(x => Number(x || 0));
  const avgCashOut = avgLastNMonths(cashOutMonthly, 3);

  const runwayMonths = avgCashOut > 0 ? (cashBalance / avgCashOut) : null;

  // Find next â€œtax-likeâ€ liability with a due date
  const TAX_BUCKETS = new Set(["GST", "PAYG", "SUPER", "INCOME_TAX", "WAGES"]);
  const nextTax = (liabilitiesRows || [])
    .filter(r => TAX_BUCKETS.has(r.bucket) && r.due_date)
    .sort((a, b) => a.due_date - b.due_date)[0];

  // Determine status level
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

  // Add tax warning if due soon
  if (nextTax && nextTax.due_in_days !== null && nextTax.due_in_days <= 21) {
    if (level === "ok") level = "warn";
    text = `${text} â€¢ ${nextTax.label} due soon`;
  }

  return { level, text, runwayMonths, nextTax };
}

function renderHealthStrip(health) {
  const badge = document.getElementById("healthBadge");
  const txt = document.getElementById("healthText");
  const runway = document.getElementById("healthRunway");
  const nextTax = document.getElementById("healthNextTax");

  if (!badge || !txt || !runway || !nextTax) return;

  // Colors (simple, inline)
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
    runway.textContent = "â€”";
  } else {
    runway.textContent = `${health.runwayMonths.toFixed(1)} months`;
  }

  if (health.nextTax) {
    const days = health.nextTax.due_in_days;
    const due = health.nextTax.due_date ? health.nextTax.due_date.toLocaleDateString() : "â€”";
    nextTax.textContent = `${health.nextTax.label} â€¢ ${due}${(days !== null ? ` (${days}d)` : "")}`;
  } else {
    nextTax.textContent = "â€”";
  }
}

function round2(x) { return Math.round(Number(x || 0) * 100) / 100; }

function fmtUSD(n) {
  const v = Number(n || 0);
  return v.toLocaleString(undefined, { style: "currency", currency: APP_CURRENCY });
}

function setAppCurrency(currencyCode) {
  const next = String(currencyCode || "").trim().toUpperCase();
  if (next) APP_CURRENCY = next;
}

function setRawData(data) {
  currentData = data;
  const raw = document.getElementById("rawOutput");
  if (raw) raw.innerText = JSON.stringify(data, null, 2);
}

function setKpiValue(valueEl, metaEl, value, options = {}) {
  const { isCurrency = true, suffix = "", warning = false, colorize = false } = options;
  if (!valueEl) return;

  if (value === null || value === undefined || Number.isNaN(Number(value))) {
    valueEl.innerText = "--";
    if (metaEl && warning) {
      metaEl.innerHTML = `<span style="display:inline-block;padding:2px 8px;border-radius:999px;background:#fff7ed;color:#9a3412;font-weight:700;font-size:10px;">CAUTION</span>`;
    }
    return;
  }

  const num = Number(value);
  valueEl.innerText = isCurrency ? fmtUSD(num) : `${num.toFixed(1)}${suffix}`;

  if (colorize) {
    valueEl.style.color = num >= 0 ? "#0f766e" : "#e11d48";
  }
  if (metaEl) metaEl.innerText = suffix ? suffix.replace(/^\s*/, "") : metaEl.innerText;
}

function formatDelta(v, asCurrency = true) {
  if (!Number.isFinite(v)) return "--";
  const sign = v > 0 ? "+" : (v < 0 ? "-" : "=");
  const abs = Math.abs(v);
  const val = asCurrency ? fmtUSD(abs) : abs.toFixed(1);
  return sign + " " + val + " vs last month";
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

function setDelta(el, value) {
  if (!el) return;
  el.classList.remove("up", "down");
  if (!Number.isFinite(value)) {
    el.textContent = "--";
    return;
  }
  el.textContent = formatDelta(value, true);
  if (value > 0) el.classList.add("up");
  if (value < 0) el.classList.add("down");
}

function seriesWithLessZeroNoise(arr) {
  const data = (arr || []).map(v => Number(v || 0));
  return data.map((v, i) => {
    if (Math.abs(v) > 0.0001) return v;
    const prev = i > 0 ? Math.abs(data[i - 1]) : 0;
    const next = i < data.length - 1 ? Math.abs(data[i + 1]) : 0;
    return (prev < 0.0001 && next < 0.0001) ? null : v;
  });
}

let SALES_MODE = "monthly";

function monthEndFromLabel(label) {
  const parts = String(label || "").split("-");
  if (parts.length !== 2) return null;
  const year = Number(parts[0]);
  const month = Number(parts[1]);
  if (!year || !month) return null;
  const lastDay = new Date(year, month, 0);
  const mm = String(lastDay.getMonth() + 1).padStart(2, "0");
  const dd = String(lastDay.getDate()).padStart(2, "0");
  return `${lastDay.getFullYear()}-${mm}-${dd}`;
}

function populateDateSelect(data) {
  const select = document.getElementById("overviewDateSelect");
  const labels = data?.charts?.sales_fy?.labels || [];
  const availableMonths = data?.meta?.available_months || [];
  if (!select || !labels.length) return;

  if (availableMonths.length) {
    select.innerHTML = availableMonths
      .map(month => `<option value="${monthEndFromLabel(month)}">${month}</option>`)
      .join("");
    const currentMonth = data?.meta?.as_of_month || (data?.meta?.today ? data.meta.today.slice(0, 7) : null);
    const idx = currentMonth ? availableMonths.indexOf(currentMonth) : -1;
    select.selectedIndex = idx >= 0 ? idx : availableMonths.length - 1;
    return;
  }

  const currentMonth = data?.meta?.as_of_month || (data?.meta?.today ? data.meta.today.slice(0, 7) : null);
  select.innerHTML = labels
    .map(label => `<option value="${monthEndFromLabel(label)}">${label}</option>`)
    .join("");

  const currentIdx = currentMonth ? labels.indexOf(currentMonth) : -1;
  select.selectedIndex = currentIdx >= 0 ? currentIdx : labels.length - 1;
}

function populateFySelect(data) {
  const fySelect = document.getElementById("fySelect");
  const liabFySelect = document.getElementById("liabFySelect");
  if (!fySelect && !liabFySelect) return;
  const fyEnd = data?.meta?.fy_end ? Number(data.meta.fy_end.slice(0, 4)) : null;
  let years = data?.meta?.available_fy_end_years || [];
  if (!years.length && fyEnd) {
    years = [fyEnd - 1, fyEnd];
  }
  years = Array.from(new Set(years.filter(y => Number.isFinite(Number(y))).map(y => Number(y)))).sort((a, b) => a - b);
  const renderOptions = (selectEl) => {
    if (!selectEl) return;
    if (years.length) {
      selectEl.innerHTML = years
        .map(y => `<option value="${y}">FY ${y - 1}-${y}</option>`)
        .join("");
    }
    if (fyEnd) {
      const option = Array.from(selectEl.options).find(o => Number(o.value) === fyEnd);
      if (option) selectEl.value = option.value;
    }
  };
  renderOptions(fySelect);
  renderOptions(liabFySelect);
}

function renderOverviewCharts(data) {
  const sales = data?.charts?.sales_fy;
  const profit = data?.charts?.profit_fy;
  const expenses = data?.charts?.expenses_fy;
  if (!sales || !profit) return;

  const labels = sales.labels || [];
  const asOfMonth = data?.meta?.as_of_month || (data?.meta?.today ? data.meta.today.slice(0, 7) : "");
  const selectedMonthLabel = (document.getElementById("overviewDateSelect")?.value || "").slice(0, 7) || asOfMonth;
  const highlightIndex = labels.indexOf(selectedMonthLabel);
  const cutoffIndex = labels.indexOf(asOfMonth);
  const salesActual = SALES_MODE === "cumulative" ? sales.actual_cumulative : sales.actual_monthly;
  const salesProjected = SALES_MODE === "cumulative" ? sales.projected_cumulative : sales.projected_monthly;

  XeroCharts.renderChart("salesFy", "salesFyChart", "line", {
    labels,
    datasets: [
      {
        label: "Actual",
        data: seriesWithLessZeroNoise(salesActual),
        borderDash: [],
        pointRadius: labels.map((_, i) => (i === highlightIndex ? 5 : 1)),
        pointHoverRadius: labels.map((_, i) => (i === highlightIndex ? 7 : 4)),
        pointBackgroundColor: labels.map((_, i) => (i === highlightIndex ? "#0f172a" : "#0f766e")),
        borderColor: "#0f766e",
        tension: 0.3,
        spanGaps: true
      },
      {
        label: "Projected",
        data: seriesWithLessZeroNoise(salesProjected),
        borderDash: [6, 4],
        pointRadius: labels.map((_, i) => (i === highlightIndex ? 5 : 1)),
        pointHoverRadius: labels.map((_, i) => (i === highlightIndex ? 7 : 4)),
        pointBackgroundColor: labels.map((_, i) => (i === highlightIndex ? "#7c2d12" : "#b45309")),
        borderColor: "#b45309",
        tension: 0.3,
        spanGaps: true
      }
    ]
  }, {
    scales: { y: { beginAtZero: true } },
    plugins: {
      monthHighlight: {
        index: highlightIndex,
        cutoffIndex,
        color: "rgba(15, 23, 42, 0.08)"
      }
    }
  });

  if (expenses) {
    const expenseActual = SALES_MODE === "cumulative" ? expenses.actual_cumulative : expenses.actual_monthly;
    const expenseProjected = SALES_MODE === "cumulative" ? expenses.projected_cumulative : expenses.projected_monthly;
    XeroCharts.renderChart("expensesFy", "expensesFyChart", "line", {
      labels: expenses.labels || labels,
      datasets: [
        {
          label: "Actual expenses",
          data: seriesWithLessZeroNoise(expenseActual),
          borderDash: [],
          pointRadius: labels.map((_, i) => (i === highlightIndex ? 5 : 1)),
          pointHoverRadius: labels.map((_, i) => (i === highlightIndex ? 7 : 4)),
          pointBackgroundColor: labels.map((_, i) => (i === highlightIndex ? "#7f1d1d" : "#b91c1c")),
          borderColor: "#b91c1c",
          tension: 0.3,
          spanGaps: true
        },
        {
          label: "Projected expenses",
          data: seriesWithLessZeroNoise(expenseProjected),
          borderDash: [6, 4],
          pointRadius: labels.map((_, i) => (i === highlightIndex ? 5 : 1)),
          pointHoverRadius: labels.map((_, i) => (i === highlightIndex ? 7 : 4)),
          pointBackgroundColor: labels.map((_, i) => (i === highlightIndex ? "#9a3412" : "#ea580c")),
          borderColor: "#ea580c",
          tension: 0.3,
          spanGaps: true
        }
      ]
    }, {
      scales: { y: { beginAtZero: true } },
      plugins: {
        monthHighlight: {
          index: highlightIndex,
          cutoffIndex,
          color: "rgba(15, 23, 42, 0.06)"
        }
      }
    });
  }

  const profitActual = SALES_MODE === "cumulative"
    ? (profit.actual_monthly_profit || []).reduce((acc, v, i) => {
        acc.push((acc[i - 1] || 0) + Number(v || 0));
        return acc;
      }, [])
    : profit.actual_monthly_profit;
  const profitProjected = SALES_MODE === "cumulative"
    ? (profit.projected_monthly_profit || []).reduce((acc, v, i) => {
        acc.push((acc[i - 1] || 0) + Number(v || 0));
        return acc;
      }, [])
    : profit.projected_monthly_profit;

  XeroCharts.renderChart("profitFy", "profitFyChart", "line", {
    labels: profit.labels || labels,
    datasets: [
      {
        label: "Actual profit",
        data: seriesWithLessZeroNoise(profitActual || []),
        borderColor: "#2563eb",
        pointRadius: labels.map((_, i) => (i === highlightIndex ? 5 : 1)),
        pointBackgroundColor: labels.map((_, i) => (i === highlightIndex ? "#0f172a" : "#2563eb")),
        tension: 0.3,
        spanGaps: true
      },
      {
        label: "Projected profit",
        data: seriesWithLessZeroNoise(profitProjected || []),
        borderColor: "#7c3aed",
        borderDash: [6, 4],
        pointRadius: labels.map((_, i) => (i === highlightIndex ? 5 : 1)),
        pointBackgroundColor: labels.map((_, i) => (i === highlightIndex ? "#0f172a" : "#7c3aed")),
        tension: 0.3,
        spanGaps: true
      }
    ]
  }, {
    scales: { y: { beginAtZero: false } },
    plugins: {
      monthHighlight: {
        index: highlightIndex,
        cutoffIndex,
        color: "rgba(15, 23, 42, 0.06)"
      }
    }
  });
}

function applyRunwayVisuals(runwayMonths) {
  const card = document.getElementById("runwayCard");
  const badge = document.getElementById("runwayRiskBadge");
  if (!card || !badge) return;
  card.classList.remove("runway-tone-red", "runway-tone-orange", "runway-tone-yellow", "runway-tone-green");
  badge.classList.remove("watch");
  badge.style.display = "none";

  if (!Number.isFinite(runwayMonths)) {
    card.classList.add("runway-tone-yellow");
    return;
  }
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

function computeProfitDeltas(data) {
  const profitNow = Number(data?.kpis?.profit_now);
  const profitNowPrev = Number(data?.kpis?.profit_now_prev);
  const futureProfit = Number(data?.kpis?.future_profit);
  const futureProfitPrev = Number(data?.kpis?.future_profit_prev);
  const profitNowDelta = Number.isFinite(profitNow) && Number.isFinite(profitNowPrev)
    ? profitNow - profitNowPrev
    : NaN;
  const futureDelta = Number.isFinite(futureProfit) && Number.isFinite(futureProfitPrev)
    ? futureProfit - futureProfitPrev
    : NaN;
  return { profitNowDelta, futureDelta };
}

function renderOverview(data) {
  const kpis = data?.kpis || {};
  setAppCurrency(data?.meta?.currency);
  populateDateSelect(data);
  populateFySelect(data);

  const currentDataMonth = data?.meta?.as_of_month || (data?.meta?.today ? data.meta.today.slice(0, 7) : "");
  const dataMonthEl = document.getElementById("overviewDataMonth");
  if (dataMonthEl) {
    dataMonthEl.textContent = `Actuals through ${formatMonthLabel(currentDataMonth)}`;
  }

  setKpiValue(
    document.getElementById("kpiProfitNow"),
    document.getElementById("kpiProfitNowMeta"),
    kpis.profit_now,
    { isCurrency: true, colorize: true, warning: true }
  );
  setKpiValue(
    document.getElementById("kpiFutureProfit"),
    document.getElementById("kpiFutureProfitMeta"),
    kpis.future_profit,
    { isCurrency: true, colorize: true, warning: true }
  );
  setKpiValue(
    document.getElementById("kpiRunway"),
    document.getElementById("kpiRunwayMeta"),
    kpis.runway_months,
    { isCurrency: false, suffix: " months", warning: true }
  );
  const runwayMeta = document.getElementById("kpiRunwayMeta");
  if (runwayMeta) runwayMeta.innerText = "";
  setKpiValue(
    document.getElementById("kpiCurLiabOverview"),
    document.getElementById("kpiCurLiabOverviewMeta"),
    kpis.current_liabilities,
    { isCurrency: true, warning: true }
  );
  setKpiValue(
    document.getElementById("kpiSalesMonth"),
    document.getElementById("kpiSalesMonthMeta"),
    kpis.sales_this_month,
    { isCurrency: true, warning: true }
  );
  setKpiValue(
    document.getElementById("kpiSpendMonth"),
    document.getElementById("kpiSpendMonthMeta"),
    kpis.spending_this_month,
    { isCurrency: true, warning: true }
  );
  const salesMeta = document.getElementById("kpiSalesMonthMeta");
  const spendMeta = document.getElementById("kpiSpendMonthMeta");
  const liabMeta = document.getElementById("kpiCurLiabOverviewMeta");
  if (salesMeta) salesMeta.innerText = "Selected FY month";
  if (spendMeta) spendMeta.innerText = "Selected FY month";
  if (liabMeta) liabMeta.innerText = "As of selected month";

  applyRunwayVisuals(Number(kpis.runway_months));
  const runwaySummary = document.getElementById("runwayBurnSummary");
  if (runwaySummary) {
    const cashInput = document.getElementById("cashBalanceInput");
    const burnInput = document.getElementById("burnMonthsInput");
    const cashVal = cashInput && cashInput.value !== "" ? Number(cashInput.value) : null;
    const burnMonths = burnInput ? Number(burnInput.value || 3) : 3;
    const burnVal = Number(kpis.monthly_burn || 0);
    if (!Number.isFinite(Number(kpis.runway_months))) {
      runwaySummary.textContent = cashVal === null
        ? "Enter a cash balance to calculate runway for the selected financial year."
        : "Runway is unavailable until there is enough expense history in the selected financial year.";
    } else {
      const cashText = Number.isFinite(cashVal) ? fmtUSD(cashVal) : "entered cash";
      const burnText = Number.isFinite(burnVal) && burnVal > 0 ? fmtUSD(burnVal) : "unknown burn";
      runwaySummary.textContent = `Based on ${cashText} cash and ${burnMonths}-month avg burn (${burnText}/month).`;
    }
  }
  const deltas = computeProfitDeltas(data);
  setDelta(document.getElementById("kpiProfitNowDelta"), deltas.profitNowDelta);
  setDelta(document.getElementById("kpiFutureProfitDelta"), deltas.futureDelta);
  const futureRisk = document.getElementById("futureProfitRiskBadge");
  if (futureRisk) {
    futureRisk.style.display = Number(kpis.future_profit || 0) < 0 ? "inline-block" : "none";
  }

  renderOverviewCharts(data);
}
// ---------- Liability due-date estimation (journal-only) ----------
// Edit these defaults to match your reality:
const LIABILITY_RULES = {
  GST:         { freq: "quarterly", days_after_period_end: 28, label: "BAS/GST (est.)" },
  PAYG:        { freq: "monthly",   days_after_period_end: 21, label: "PAYG Withholding (est.)" },
  SUPER:       { freq: "quarterly", days_after_period_end: 28, label: "Superannuation (est.)" },
  WAGES:       { freq: "monthly",   days_after_period_end: 7,  label: "Wages payable (est.)" },
  INCOME_TAX:  { freq: "quarterly", days_after_period_end: 28, label: "Income tax payable (est.)" },

  // These are NOT predictable from journals alone:
  LOAN:        null,
  OTHER:       null
};

function classifyLiabilityAccount(accountCode, accountName) {
  const code = String(accountCode || "").trim();
  const name = String(accountName || "").toLowerCase();

  // Prefer code when you have it
  if (code.startsWith("820") || name.includes("gst")) return "GST";
  if (code.startsWith("825") || name.includes("payg") || name.includes("withholding")) return "PAYG";
  if (code.startsWith("826") || name.includes("super")) return "SUPER";
  if (code.startsWith("804") || name.includes("wages payable") || name.includes("payroll")) return "WAGES";
  if (code.startsWith("830") || name.includes("income tax")) return "INCOME_TAX";
  if (code.startsWith("900") || name.includes("loan")) return "LOAN";

  // Explicit â€œdo not estimateâ€
  if (code.startsWith("840") || name.includes("historical")) return "OTHER";
  if (code.startsWith("850") || name.includes("suspense")) return "OTHER";
  if (code.startsWith("860") || name.includes("rounding")) return "OTHER";
  if (code.startsWith("880") || name.includes("drawings")) return "OTHER";
  if (code.startsWith("881") || name.includes("funds introduced")) return "OTHER";

  return "OTHER";
}

function endOfMonth(d) {
  return new Date(d.getFullYear(), d.getMonth() + 1, 0); // last day of month
}
function endOfQuarter(d) {
  const q = Math.floor(d.getMonth() / 3); // 0..3
  const endMonth = q * 3 + 2;             // 2,5,8,11
  return new Date(d.getFullYear(), endMonth + 1, 0);
}
function addDays(d, days) {
  const x = new Date(d);
  x.setDate(x.getDate() + days);
  return x;
}
function fmtDate(d) {
  if (!(d instanceof Date) || isNaN(d.getTime())) return "â€”";
  return d.toLocaleDateString();
}
function daysUntil(dueDate) {
  const today = new Date();
  const start = new Date(today.getFullYear(), today.getMonth(), today.getDate());
  const due = new Date(dueDate.getFullYear(), dueDate.getMonth(), dueDate.getDate());
  return Math.round((due - start) / (1000 * 60 * 60 * 24));
}

/**
 * Takes JOURNAL_LINES (flattened) and returns liability balances + estimated due dates.
 * We estimate due date based on LAST ACTIVITY date in that liability bucket.
 */
function computeLiabilityDueEstimates(lines) {
  const buckets = {}; // key bucket -> { bucket, label, total, lastDate, accounts:Set }
  for (const ln of lines) {
    if (ln.accountType !== "CURRLIAB") continue;

    const bucket = classifyLiabilityAccount(ln.accountCode, ln.accountName);
    const rule = LIABILITY_RULES[bucket];
    // We still track totals even if rule is null (but due date will be â€”)

    if (!buckets[bucket]) {
      buckets[bucket] = {
        bucket,
        label: rule?.label || bucket,
        total: 0,
        lastDate: null,
        accounts: new Set()
      };
    }

    const amt = Number(ln.net || 0);
    buckets[bucket].total += amt;

    const d = XeroTables.parseXeroDate(ln.date);
    if (!buckets[bucket].lastDate || d > buckets[bucket].lastDate) buckets[bucket].lastDate = d;

    buckets[bucket].accounts.add(`${ln.accountCode} - ${ln.accountName}`.trim());
  }

  // Build output rows
  const rows = Object.values(buckets).map(b => {
    const rule = LIABILITY_RULES[b.bucket];
    let due = null;

    if (rule && b.lastDate) {
      const periodEnd = rule.freq === "monthly" ? endOfMonth(b.lastDate) : endOfQuarter(b.lastDate);
      due = addDays(periodEnd, rule.days_after_period_end);
    }

    return {
      bucket: b.bucket,
      label: b.label,
      balance: b.total,                 // proxy balance from journal history
      last_activity: b.lastDate,
      due_date: due,
      due_in_days: due ? daysUntil(due) : null,
      accounts: Array.from(b.accounts).slice(0, 6) // for display
    };
  });

  // Sort: items with due date soonest first, then others
  rows.sort((a, b) => {
    if (a.due_date && b.due_date) return a.due_date - b.due_date;
    if (a.due_date) return -1;
    if (b.due_date) return 1;
    return Math.abs(b.balance) - Math.abs(a.balance);
  });

  return rows;
}

// ---------- Liability due estimates ----------
function renderLiabilitySummary(rows) {
  const totalCur = rows.reduce((a, r) => a + Number(r.outstanding || 0), 0);
  const dueSoon = rows
    .filter(r => r.status === "Due soon" || r.status === "Overdue")
    .reduce((a, r) => a + Number(r.outstanding || 0), 0);
  const other = Math.max(0, totalCur - dueSoon);

  document.getElementById("kpiCurLiab").innerText = fmtUSD(totalCur);
  document.getElementById("kpiTaxLiab").innerText = fmtUSD(dueSoon);
  document.getElementById("kpiOtherLiab").innerText = fmtUSD(other);

  const th = document.getElementById("liabHeader");
  const tb = document.getElementById("liabBody");
  th.innerHTML = `
    <tr>
      <th>Account</th>
      <th>Obligation created</th>
      <th>Amount paid</th>
      <th>Outstanding</th>
      <th>First accrual</th>
      <th>Last payment</th>
      <th>Last activity</th>
      <th>Expected due</th>
      <th>Days</th>
      <th>Status</th>
    </tr>`;
  tb.innerHTML = rows.map(r => `
    <tr>
      <td>${`${r.account_code} ${r.account_name}`.trim()}</td>
      <td>${XeroTables.formatCurrency(r.obligation_created)}</td>
      <td>${XeroTables.formatCurrency(r.amount_paid)}</td>
      <td>${XeroTables.formatCurrency(r.outstanding)} ${r.outstanding_sign === "credit" ? "(credit)" : "(owed)"}</td>
      <td>${r.first_accrual_date ? new Date(r.first_accrual_date).toLocaleDateString() : "--"}</td>
      <td>${r.last_payment_date ? new Date(r.last_payment_date).toLocaleDateString() : "--"}</td>
      <td>${r.last_activity_date ? new Date(r.last_activity_date).toLocaleDateString() : "--"}</td>
      <td>${r.expected_due_date ? new Date(r.expected_due_date).toLocaleDateString() : "--"}</td>
      <td>${r.days_to_due === null || r.days_to_due === undefined ? "--" : r.days_to_due}</td>
      <td>${r.status}</td>
    </tr>
  `).join("");
}

async function showLiabilities() {
  hideAllViews();
  setLoading("Building liabilities view...");

  try {
    const fySelect = document.getElementById("liabFySelect");
    const todayOverride = fySelect ? fyEndDateFromYear(fySelect.value) : null;
    const qs = todayOverride ? `?today=${encodeURIComponent(todayOverride)}` : "";
    const data = await XeroAPI.fetch_json(`/api/dashboard/liabilities${qs}`);
    setRawData(data);

    stopLoading();
    document.getElementById("liabilitiesContainer").style.display = "block";
    renderLiabilitySummary(data.rows || []);
  } catch (e) {
    stopLoading();
    showError(e.message);
  }
}

window.showLiabilities = showLiabilities;

function budgetRowHtml(row = {}, idx = 0) {
  const dateValue = String(row.JOURNAL_DATE || row.journal_date || "").slice(0, 10);
  const typeValue = String(row.ACCOUNT_TYPE || row.account_type || "EXPENSE").toUpperCase();
  const nameValue = String(row.ACCOUNT_NAME || row.account_name || "");
  let amountValue = Number(row.NET_AMOUNT ?? row.net_amount ?? 0);
  if (typeValue === "REVENUE") amountValue = Math.abs(amountValue);

  return `
    <tr data-budget-idx="${idx}">
      <td><input type="date" class="budget-date" value="${dateValue}" style="padding:8px; width:150px;"></td>
      <td>
        <select class="budget-type" style="padding:8px; width:130px;">
          <option value="REVENUE" ${typeValue === "REVENUE" ? "selected" : ""}>REVENUE</option>
          <option value="EXPENSE" ${typeValue === "EXPENSE" ? "selected" : ""}>EXPENSE</option>
        </select>
      </td>
      <td><input type="text" class="budget-name" value="${nameValue}" placeholder="e.g. Sales" style="padding:8px; width:220px;"></td>
      <td><input type="number" class="budget-amount" value="${Number.isFinite(amountValue) ? amountValue : 0}" step="0.01" style="padding:8px; width:140px;"></td>
      <td><button type="button" class="btn-muted" onclick="removeBudgetRow(${idx})">Delete</button></td>
    </tr>`;
}

function collectBudgetRowsFromTable() {
  const body = document.getElementById("budgetBody");
  if (!body) return [];
  const trs = Array.from(body.querySelectorAll("tr"));
  return trs.map(tr => {
    const accountType = tr.querySelector(".budget-type")?.value || "";
    const accountName = tr.querySelector(".budget-name")?.value || "";
    const journalDate = tr.querySelector(".budget-date")?.value || "";
    const enteredAmount = Number(tr.querySelector(".budget-amount")?.value || 0);
    const netAmount = accountType === "REVENUE"
      ? -Math.abs(enteredAmount)
      : Math.abs(enteredAmount);
    return {
      ACCOUNT_TYPE: accountType,
      ACCOUNT_NAME: accountName,
      DATA_CATEGORY: "Budget",
      JOURNAL_DATE: journalDate,
      NET_AMOUNT: netAmount
    };
  }).filter(r => r.ACCOUNT_NAME && r.JOURNAL_DATE);
}

function renderBudgetRows(rows) {
  const body = document.getElementById("budgetBody");
  if (!body) return;
  if (!rows || !rows.length) {
    body.innerHTML = budgetRowHtml({}, 0);
    return;
  }
  body.innerHTML = rows.map((row, idx) => budgetRowHtml(row, idx)).join("");
}

async function loadBudgetRows() {
  setLoading("Loading budget...");
  try {
    const data = await XeroAPI.fetch_json("/api/budget");
    setRawData(data);
    const meta = document.getElementById("budgetMeta");
    if (meta) {
      meta.innerText = `Mode: ${data.mode || "--"} | Source: ${data.source || "--"}`;
    }
    renderBudgetRows(data.rows || []);
    stopLoading();
    return data;
  } catch (e) {
    stopLoading();
    showError(e.message);
    return null;
  }
}

async function saveBudgetRows() {
  const rows = collectBudgetRowsFromTable();
  setLoading("Saving budget...");
  try {
    const data = await XeroAPI.request_json("/api/budget", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ rows })
    });
    setRawData(data);
    renderBudgetRows(data.rows || []);
    stopLoading();
  } catch (e) {
    stopLoading();
    showError(e.message);
  }
}

function addBudgetRow() {
  const body = document.getElementById("budgetBody");
  if (!body) return;
  const currentRows = Array.from(body.querySelectorAll("tr"));
  const idx = currentRows.length;
  body.insertAdjacentHTML("beforeend", budgetRowHtml({}, idx));
}

function removeBudgetRow(idx) {
  const body = document.getElementById("budgetBody");
  if (!body) return;
  const row = body.querySelector(`tr[data-budget-idx="${idx}"]`);
  if (row) row.remove();
  const rows = collectBudgetRowsFromTable();
  renderBudgetRows(rows);
}

async function showBudgetInput() {
  hideAllViews();
  document.getElementById("budgetContainer").style.display = "block";
  await loadBudgetRows();
}

window.showBudgetInput = showBudgetInput;
window.loadBudgetRows = loadBudgetRows;
window.saveBudgetRows = saveBudgetRows;
window.addBudgetRow = addBudgetRow;
window.removeBudgetRow = removeBudgetRow;

// ---------- Dashboard model from journal lines ----------
function buildDashboardModel(lines) {
  const months = {}; // { "YYYY-MM": { income, expense, bankIn, bankOut } }
  const expenseByCategory = {};
  const bankOutByDesc = {};

  let cashDelta = 0;

  for (const ln of lines) {
    const m = monthKey(ln.date);
    if (!months[m]) months[m] = { income: 0, expense: 0, bankIn: 0, bankOut: 0 };

    const amt = Number(ln.net || 0);

    // P&L (journal-only classification)
    if (INCOME_TYPES.has(ln.accountType)) {
      months[m].income += Math.abs(amt);
    }
    if (EXPENSE_TYPES.has(ln.accountType)) {
      months[m].expense += Math.abs(amt);
      const key = (ln.accountName || ln.accountCode || "Uncategorized").trim();
      expenseByCategory[key] = (expenseByCategory[key] || 0) + Math.abs(amt);
    }

    // Cashflow proxy from BANK account lines
    if (BANK_TYPES.has(ln.accountType)) {
      cashDelta += amt;
      if (amt >= 0) months[m].bankIn += amt;
      else {
        months[m].bankOut += Math.abs(amt);
        const d = (ln.description || "Other").slice(0, 60);
        bankOutByDesc[d] = (bankOutByDesc[d] || 0) + Math.abs(amt);
      }
    }
  }

  const labels = Object.keys(months).sort();
  const income = labels.map(k => round2(months[k].income));
  const expense = labels.map(k => round2(months[k].expense));
  const profit = labels.map((k, i) => round2(income[i] - expense[i]));

  const cashIn = labels.map(k => round2(months[k].bankIn));
  const cashOut = labels.map(k => round2(months[k].bankOut));

  const last = labels[labels.length - 1];
  const lastIncome = last ? months[last].income : 0;
  const lastExpense = last ? months[last].expense : 0;
  const lastProfit = lastIncome - lastExpense;

  const topExpenses = Object.entries(expenseByCategory)
    .sort((a,b) => b[1] - a[1])
    .slice(0, 8);

  const topOutflows = Object.entries(bankOutByDesc)
    .sort((a,b) => b[1] - a[1])
    .slice(0, 8);

  return {
    kpis: {
      cash_balance_proxy: cashDelta,
      monthly_revenue: lastIncome,
      monthly_expenses: lastExpense,
      monthly_profit: lastProfit
    },
    charts: {
      plTrend: { labels, income, expense },
      expenseCategories: { labels: topExpenses.map(x => x[0]), values: topExpenses.map(x => round2(x[1])) },
      cashflow: { labels, cashIn, cashOut }
    },
    topOutflows
  };
}

// ---------- Render dashboard ----------
function renderDashboard(model) {
  document.getElementById("kpiCash").innerText = fmtUSD(model.kpis.cash_balance_proxy);
  document.getElementById("kpiRevenue").innerText = fmtUSD(model.kpis.monthly_revenue);
  document.getElementById("kpiExpenses").innerText = fmtUSD(model.kpis.monthly_expenses);
  document.getElementById("kpiProfit").innerText = fmtUSD(model.kpis.monthly_profit);

  // journal-only placeholders
  document.getElementById("kpiAR").innerText = "â€”";
  document.getElementById("kpiAP").innerText = "â€”";

  XeroCharts.renderChart("plTrend", "plTrendChart", "line", {
    labels: model.charts.plTrend.labels,
    datasets: [
      { label: "Revenue", data: model.charts.plTrend.income },
      { label: "Expenses", data: model.charts.plTrend.expense }
    ]
  }, { scales: { y: { beginAtZero: true } } });

  XeroCharts.renderChart("expCats", "expenseCategoryChart", "bar", {
    labels: model.charts.expenseCategories.labels,
    datasets: [{ label: "Expenses by category", data: model.charts.expenseCategories.values }]
  }, { scales: { y: { beginAtZero: true } } });

  XeroCharts.renderChart("cashflow", "cashflowChart", "bar", {
    labels: model.charts.cashflow.labels,
    datasets: [
      { label: "Cash In (bank)", data: model.charts.cashflow.cashIn },
      { label: "Cash Out (bank)", data: model.charts.cashflow.cashOut }
    ]
  }, { scales: { y: { beginAtZero: true } } });

  const out = document.getElementById("bigOutflows");
  out.innerHTML = model.topOutflows.length
    ? model.topOutflows.map(([k,v]) =>
        `<div style="display:flex; justify-content:space-between; padding:6px 0; border-bottom:1px solid #eee;">
          <div>${k}</div><div><b>${fmtUSD(v)}</b></div>
        </div>`
      ).join("")
    : `<div class="muted">No BANK outflows found in journal lines.</div>`;
}

// ---------- Transactions table ----------
function escapeHtmlText(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function formatJournalTypeLabel(type) {
  const map = {
    REVENUE: "Revenue",
    EXPENSE: "Expense",
    CURRLIAB: "Liability",
    BANK: "Bank",
    EQUITY: "Equity",
    FIXED: "Fixed asset",
    CURRENT: "Current asset"
  };
  return map[String(type || "").toUpperCase()] || String(type || "Other");
}

function populateTransactionTypeFilter(lines) {
  const select = document.getElementById("filterType");
  if (!select) return;
  const current = select.value;
  const types = Array.from(new Set((lines || []).map(r => String(r.accountType || "").trim()).filter(Boolean))).sort();
  select.innerHTML = ['<option value="">All types</option>']
    .concat(types.map(t => `<option value="${escapeHtmlText(t)}">${escapeHtmlText(formatJournalTypeLabel(t))}</option>`))
    .join("");
  if (types.includes(current)) select.value = current;
}

function renderTransactionTable(lines) {
  const cols = [
    { label: "Date", render: r => XeroTables.formatDate(r.date) },
    { label: "Account", render: r => `<div class="tx-account-cell"><strong>${escapeHtmlText(`${r.accountCode} ${r.accountName}`.trim())}</strong></div>` },
    { label: "Type", render: r => escapeHtmlText(formatJournalTypeLabel(r.accountType)) },
    { label: "Description", render: r => `<div class="tx-desc-cell">${escapeHtmlText(r.description || "—")}</div>` },
    { label: "Money In", render: r => `<div class="tx-money money-in">${Number(r.net || 0) < 0 ? XeroTables.formatCurrency(Math.abs(Number(r.net || 0))) : "—"}</div>` },
    { label: "Money Out", render: r => `<div class="tx-money money-out">${Number(r.net || 0) > 0 ? XeroTables.formatCurrency(Number(r.net || 0)) : "—"}</div>` }
  ];

  const total = lines.length;
  const totalPages = Math.max(1, Math.ceil(total / TX_PAGE_SIZE));
  if (TX_CURRENT_PAGE > totalPages) TX_CURRENT_PAGE = totalPages;
  if (TX_CURRENT_PAGE < 1) TX_CURRENT_PAGE = 1;

  const start = (TX_CURRENT_PAGE - 1) * TX_PAGE_SIZE;
  const end = Math.min(start + TX_PAGE_SIZE, total);
  const slice = lines.slice(start, end);

  XeroTables.renderTable(cols, slice);
  const body = document.getElementById("tableBody");
  if (body) {
    body.querySelectorAll("tr").forEach((rowEl, index) => {
      const rowData = slice[index];
      if (!rowData) return;
      rowEl.dataset.sourceIndex = String(start + index);
      rowEl.addEventListener("click", () => openTransactionQuickView(rowData));
      rowEl.addEventListener("keydown", (event) => {
        if (event.key !== "Enter" && event.key !== " ") return;
        openTransactionQuickView(rowData);
      });
    });
  }

  const txCount = document.getElementById("txCount");
  if (txCount) {
    txCount.textContent = total
      ? `Showing ${start + 1}-${end} of ${total.toLocaleString()} lines`
      : "Showing 0 of 0 lines";
  }
  const txPageInfo = document.getElementById("txPageInfo");
  if (txPageInfo) txPageInfo.textContent = `Page ${TX_CURRENT_PAGE} of ${totalPages}`;
  const prevBtn = document.getElementById("txPrevBtn");
  const nextBtn = document.getElementById("txNextBtn");
  if (prevBtn) prevBtn.disabled = TX_CURRENT_PAGE <= 1 || total === 0;
  if (nextBtn) nextBtn.disabled = TX_CURRENT_PAGE >= totalPages || total === 0;
}

function applyTransactionFilters() {
  if (!JOURNAL_LINES) return;

  const q = (document.getElementById("filterAccount").value || "").toLowerCase();
  const type = document.getElementById("filterType")?.value || "";
  const direction = document.getElementById("filterDirection")?.value || "";
  const from = document.getElementById("filterFrom").value;
  const to = document.getElementById("filterTo").value;

  const fromDate = from ? new Date(from) : null;
  const toDate = to ? new Date(to) : null;

  const filtered = JOURNAL_LINES.filter(r => {
    const acc = `${r.accountCode} ${r.accountName}`.toLowerCase();
    if (q && !acc.includes(q)) return false;
    if (type && String(r.accountType || "") !== type) return false;

    const amount = Number(r.net || 0);
    if (direction === "in" && !(amount < 0)) return false;
    if (direction === "out" && !(amount > 0)) return false;

    const d = XeroTables.parseXeroDate(r.date);
    if (fromDate && d < fromDate) return false;
    if (toDate && d > toDate) return false;

    return true;
  });

  FILTERED_JOURNAL_LINES = filtered;
  TX_CURRENT_PAGE = 1;
  renderTransactionFilterChips();
  renderTransactionTable(FILTERED_JOURNAL_LINES);
}

window.applyTransactionFilters = applyTransactionFilters;

function resetTransactionFilters() {
  const ids = ["filterAccount", "filterFrom", "filterTo"];
  ids.forEach(id => {
    const el = document.getElementById(id);
    if (el) el.value = "";
  });
  const typeEl = document.getElementById("filterType");
  const dirEl = document.getElementById("filterDirection");
  if (typeEl) typeEl.value = "";
  if (dirEl) dirEl.value = "";
  FILTERED_JOURNAL_LINES = JOURNAL_LINES || [];
  TX_CURRENT_PAGE = 1;
  renderTransactionFilterChips();
  renderTransactionTable(FILTERED_JOURNAL_LINES);
}

window.resetTransactionFilters = resetTransactionFilters;

function changeTransactionPage(delta) {
  if (!FILTERED_JOURNAL_LINES) {
    FILTERED_JOURNAL_LINES = JOURNAL_LINES || [];
  }
  TX_CURRENT_PAGE += Number(delta || 0);
  renderTransactionTable(FILTERED_JOURNAL_LINES);
}

window.changeTransactionPage = changeTransactionPage;

function getTransactionFilterState() {
  return {
    account: document.getElementById("filterAccount")?.value || "",
    type: document.getElementById("filterType")?.value || "",
    direction: document.getElementById("filterDirection")?.value || "",
    from: document.getElementById("filterFrom")?.value || "",
    to: document.getElementById("filterTo")?.value || ""
  };
}

function clearTransactionFilter(key) {
  const elementByKey = {
    account: "filterAccount",
    type: "filterType",
    direction: "filterDirection",
    from: "filterFrom",
    to: "filterTo"
  };
  const id = elementByKey[key];
  const el = id ? document.getElementById(id) : null;
  if (!el) return;
  el.value = "";
  applyTransactionFilters();
}

function renderTransactionFilterChips() {
  const container = document.getElementById("txActiveFilters");
  if (!container) return;

  const state = getTransactionFilterState();
  const chips = [];

  if (state.account) chips.push({ key: "account", label: `Account: ${state.account}` });
  if (state.type) chips.push({ key: "type", label: `Type: ${formatJournalTypeLabel(state.type)}` });
  if (state.direction) chips.push({ key: "direction", label: `Direction: ${state.direction === "in" ? "Money in" : "Money out"}` });
  if (state.from) chips.push({ key: "from", label: `From: ${state.from}` });
  if (state.to) chips.push({ key: "to", label: `To: ${state.to}` });

  if (!chips.length) {
    container.innerHTML = `<span class="muted">No active filters</span>`;
    return;
  }

  container.innerHTML = chips.map(chip => (
    `<span class="tx-filter-chip">${escapeHtmlText(chip.label)}<button type="button" aria-label="Remove ${escapeHtmlText(chip.label)}" onclick="clearTransactionFilter('${chip.key}')">&times;</button></span>`
  )).join("") + `<button type="button" class="tx-clear-link" onclick="resetTransactionFilters()">Clear all</button>`;
}

window.clearTransactionFilter = clearTransactionFilter;

function closeTransactionQuickView() {
  const panel = document.getElementById("txQuickView");
  if (!panel) return;
  panel.classList.remove("is-open");
  panel.setAttribute("aria-hidden", "true");
}

function openTransactionQuickView(row) {
  const panel = document.getElementById("txQuickView");
  const body = document.getElementById("txQuickViewBody");
  if (!panel || !body || !row) return;

  const amount = Number(row.net || 0);
  const moneyIn = amount < 0 ? XeroTables.formatCurrency(Math.abs(amount)) : "—";
  const moneyOut = amount > 0 ? XeroTables.formatCurrency(amount) : "—";
  const netClass = amount < 0 ? "money-in" : amount > 0 ? "money-out" : "";

  body.innerHTML = `
    <div class="tx-quickview-grid">
      <div class="tx-quickview-field"><span class="tx-quickview-label">Date</span><div class="tx-quickview-value">${escapeHtmlText(XeroTables.formatDate(row.date))}</div></div>
      <div class="tx-quickview-field"><span class="tx-quickview-label">Type</span><div class="tx-quickview-value">${escapeHtmlText(formatJournalTypeLabel(row.accountType))}</div></div>
      <div class="tx-quickview-field wide"><span class="tx-quickview-label">Account name</span><div class="tx-quickview-value">${escapeHtmlText(row.accountName || "—")}</div></div>
      <div class="tx-quickview-field"><span class="tx-quickview-label">Account code</span><div class="tx-quickview-value">${escapeHtmlText(row.accountCode || "—")}</div></div>
      <div class="tx-quickview-field"><span class="tx-quickview-label">Journal</span><div class="tx-quickview-value">${escapeHtmlText(row.journalNumber || "—")}</div></div>
      <div class="tx-quickview-field wide"><span class="tx-quickview-label">Description</span><div class="tx-quickview-value">${escapeHtmlText(row.description || "—")}</div></div>
      <div class="tx-quickview-field wide"><span class="tx-quickview-label">Journal ID</span><div class="tx-quickview-value">${escapeHtmlText(row.journalId || "—")}</div></div>
    </div>
    <div class="tx-quickview-money">
      <div class="tx-quickview-field"><span class="tx-quickview-label">Money in</span><div class="tx-quickview-value money-in">${escapeHtmlText(moneyIn)}</div></div>
      <div class="tx-quickview-field"><span class="tx-quickview-label">Money out</span><div class="tx-quickview-value money-out">${escapeHtmlText(moneyOut)}</div></div>
      <div class="tx-quickview-field"><span class="tx-quickview-label">Net amount</span><div class="tx-quickview-value ${netClass}">${escapeHtmlText(XeroTables.formatCurrency(amount))}</div></div>
    </div>
  `;

  panel.classList.add("is-open");
  panel.setAttribute("aria-hidden", "false");
}

window.closeTransactionQuickView = closeTransactionQuickView;

function changeTransactionPageSize(value) {
  const parsed = Number(value || 100);
  TX_PAGE_SIZE = Number.isFinite(parsed) && parsed > 0 ? parsed : 100;
  TX_CURRENT_PAGE = 1;
  renderTransactionTable(FILTERED_JOURNAL_LINES || JOURNAL_LINES || []);
}

window.changeTransactionPageSize = changeTransactionPageSize;

// ---------- Navigation ----------
async function showDashboard() {
  hideAllViews();
  setLoading("Loading overview...");

  try {
    const data = await fetchOverview();

    stopLoading();
    document.getElementById("dashboardContainer").style.display = "block";
    renderOverview(data);

  } catch (e) {
    stopLoading();
    showError(e.message);
  }
}

async function fetchOverview(todayStr, fyStartMonth = 7, cashBalance = null, burnMonths = null) {
  const params = new URLSearchParams();
  if (todayStr) params.set("today", todayStr);
  if (fyStartMonth) params.set("fy_start_month", String(fyStartMonth));
  if (cashBalance !== null && cashBalance !== "" && Number.isFinite(Number(cashBalance))) {
    params.set("cash_balance", String(cashBalance));
  }
  if (burnMonths !== null && burnMonths !== "" && Number.isFinite(Number(burnMonths))) {
    params.set("burn_months", String(burnMonths));
  }
  const qs = params.toString() ? `?${params.toString()}` : "";
  const data = await XeroAPI.fetch_json(`/api/dashboard/overview${qs}`);
  setRawData(data);
  return data;
}


async function showTransactions() {
  hideAllViews();
  setLoading("Loading journal lines...");
  try {
    const journals = await getJournals();
    JOURNAL_LINES = flattenJournalLines(journals);
    populateTransactionTypeFilter(JOURNAL_LINES);

    // âœ… ADD THIS LINE
    console.log(
      "journals:", journals.length,
      "lines:", JOURNAL_LINES.length,
      "sample:", JOURNAL_LINES[0]
    );

    setRawData({
      journals_count: journals.length,
      journal_lines_count: JOURNAL_LINES.length
    });

    stopLoading();
    document.getElementById("transactionsContainer").style.display = "block";
    FILTERED_JOURNAL_LINES = JOURNAL_LINES;
    TX_CURRENT_PAGE = 1;
    renderTransactionFilterChips();
    renderTransactionTable(FILTERED_JOURNAL_LINES);
  } catch (e) {
    stopLoading();
    showError(e.message);
  }
}


window.showDashboard = showDashboard;
window.showTransactions = showTransactions;

// ---------- Raw JSON toggle ----------
function showRawJson() {
  if (!currentData) return;
  const raw = document.getElementById("rawOutput");
  const btn = document.getElementById("rawJsonBtn");
  if (!raw || !btn) return;

  if (showingRaw) {
    raw.style.display = "none";
    const dash = document.getElementById("dashboardContainer");
    if (dash) dash.style.display = "block";
    btn.innerText = "Show Raw JSON";
    showingRaw = false;
  } else {
    // hide views, show raw
    const dash = document.getElementById("dashboardContainer");
    const tx = document.getElementById("transactionsContainer");
    const liab = document.getElementById("liabilitiesContainer");
    const budget = document.getElementById("budgetContainer");
    if (dash) dash.style.display = "none";
    if (tx) tx.style.display = "none";
    if (liab) liab.style.display = "none";
    if (budget) budget.style.display = "none";
    raw.style.display = "block";
    raw.innerText = JSON.stringify(currentData, null, 2);
    btn.innerText = "Show UI";
    showingRaw = true;
  }
}
window.showRawJson = showRawJson;

// ---------- Auth + health ----------
async function logoutSession() {
  try {
    await XeroAPI.fetch_json("/auth/logout");
  } catch (_) {
    // Even if API call fails, force navigation to login screen.
  }
  window.location.href = "/";
}

function authorize() {
  const w = XeroAPI.open_auth_popup();
  if (!w) {
    // Auth now runs in same tab (/auth/start), so no popup is expected.
    return;
  }
  const timer = setInterval(() => {
    if (w.closed) {
      clearInterval(timer);
      setTimeout(async () => {
        await loadOrganizations();
        await showDashboard();
      }, 800);
    }
  }, 800);
}

async function checkHealth() {
  try {
    const data = await XeroAPI.fetch_json("/health");
    alert(JSON.stringify(data, null, 2));
  } catch (e) {
    showError(e.message);
  }
}

window.authorize = authorize;
window.logoutSession = logoutSession;
window.checkHealth = checkHealth;

function setXeroConnectionStatus(connected) {
  const pill = document.getElementById("xeroConnectionPill");
  const link = document.getElementById("xeroConnectLink");
  const select = document.getElementById("orgSelect");

  if (pill) {
    pill.classList.toggle("connected", connected);
    pill.classList.toggle("disconnected", !connected);
    pill.textContent = connected ? "Xero: Connected" : "Xero: Not connected";
  }
  if (link) {
    link.style.display = connected ? "none" : "inline-flex";
  }
  if (select && !connected) {
    select.innerHTML = `<option value="">Organization</option>`;
    select.disabled = true;
  }
}

window.addEventListener("message", async (event) => {
  if (event.origin !== window.location.origin) return;
  if (event.data?.type !== "xero-auth-success") return;
  await loadOrganizations();
  await showDashboard();
});

async function loadOrganizations() {
  const select = document.getElementById("orgSelect");
  if (!select) return;

  try {
    const data = await XeroAPI.fetch_json("/connections");
    const connections = data?.connections || [];
    const savedTenantId = data?.saved_tenant_id || "";

    if (!connections.length) {
      setXeroConnectionStatus(false);
      select.innerHTML = `<option value="">No organizations</option>`;
      select.disabled = true;
      return;
    }

    select.innerHTML = connections
      .map(c => {
        const tenantId = c.tenantId || "";
        const tenantName = c.tenantName || c.tenantType || tenantId;
        const selected = tenantId === savedTenantId ? "selected" : "";
        return `<option value="${tenantId}" ${selected}>${tenantName}</option>`;
      })
      .join("");
    select.disabled = false;
    setXeroConnectionStatus(true);
  } catch (e) {
    setXeroConnectionStatus(false);
    select.innerHTML = `<option value="">Org unavailable</option>`;
    select.disabled = true;
  }
}

async function switchOrganization(tenantId) {
  if (!tenantId) return;
  setLoading("Switching organization...");
  try {
    await XeroAPI.fetch_json(`/set-tenant?tenantId=${encodeURIComponent(tenantId)}`);
    await showDashboard();
    stopLoading();
  } catch (e) {
    stopLoading();
    showError(e.message);
  }
}

function setSalesMode(mode) {
  SALES_MODE = mode;
  const monthlyBtn = document.getElementById("salesModeMonthly");
  const cumulativeBtn = document.getElementById("salesModeCumulative");
  if (monthlyBtn && cumulativeBtn) {
    monthlyBtn.classList.toggle("active", mode === "monthly");
    cumulativeBtn.classList.toggle("active", mode === "cumulative");
  }
  if (currentData) renderOverviewCharts(currentData);
}

function fyEndDateFromYear(endYear) {
  const y = Number(endYear);
  if (!y) return null;
  return `${y}-06-30`;
}

// Auto-open dashboard on page load
document.addEventListener("DOMContentLoaded", () => {
  const monthlyBtn = document.getElementById("salesModeMonthly");
  const cumulativeBtn = document.getElementById("salesModeCumulative");
  const dateSelect = document.getElementById("overviewDateSelect");
  const fySelect = document.getElementById("fySelect");
  const cashInput = document.getElementById("cashBalanceInput");
  const burnMonthsInput = document.getElementById("burnMonthsInput");
  const liabFySelect = document.getElementById("liabFySelect");
  const orgSelect = document.getElementById("orgSelect");
  if (monthlyBtn) monthlyBtn.addEventListener("click", () => setSalesMode("monthly"));
  if (cumulativeBtn) cumulativeBtn.addEventListener("click", () => setSalesMode("cumulative"));
  if (dateSelect) {
    dateSelect.addEventListener("change", async (e) => {
      const val = e.target.value;
      if (!val) return;
      setLoading("Refreshing overview...");
      try {
        const data = await fetchOverview(val, 7, cashInput?.value, burnMonthsInput?.value);
        stopLoading();
        renderOverview(data);
      } catch (err) {
        stopLoading();
        showError(err.message);
      }
    });
  }
  if (fySelect) {
    fySelect.addEventListener("change", async (e) => {
      const endYear = e.target.value;
      const today = fyEndDateFromYear(endYear);
      if (!today) return;
      setLoading("Refreshing overview...");
      try {
        const data = await fetchOverview(today, 7, cashInput?.value, burnMonthsInput?.value);
        stopLoading();
        renderOverview(data);
      } catch (err) {
        stopLoading();
        showError(err.message);
      }
    });
  }
  if (cashInput) {
    const handler = async () => {
      const todayOverride = dateSelect?.value || null;
      setLoading("Refreshing overview...");
      try {
        const data = await fetchOverview(todayOverride, 7, cashInput.value, burnMonthsInput?.value);
        stopLoading();
        renderOverview(data);
      } catch (err) {
        stopLoading();
        showError(err.message);
      }
    };
    cashInput.addEventListener("change", handler);
    cashInput.addEventListener("blur", handler);
  }
  if (burnMonthsInput) {
    const handler = async () => {
      const todayOverride = dateSelect?.value || null;
      setLoading("Refreshing overview...");
      try {
        const data = await fetchOverview(todayOverride, 7, cashInput?.value, burnMonthsInput.value);
        stopLoading();
        renderOverview(data);
      } catch (err) {
        stopLoading();
        showError(err.message);
      }
    };
    burnMonthsInput.addEventListener("change", handler);
  }
  if (liabFySelect) {
    liabFySelect.addEventListener("change", async () => {
      setLoading("Refreshing liabilities...");
      try {
        await showLiabilities();
        stopLoading();
      } catch (err) {
        stopLoading();
        showError(err.message);
      }
    });
  }
  if (orgSelect) {
    orgSelect.addEventListener("change", async (e) => {
      await switchOrganization(e.target.value);
    });
    loadOrganizations();
  }
  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape") {
      closeTransactionQuickView();
    }
  });
  setSalesMode("monthly");
  showDashboard();
});




