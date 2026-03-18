let JOURNAL_CACHE = null;
let JOURNAL_LINES = null;
let FILTERED_JOURNAL_LINES = null;
let TX_CURRENT_PAGE = 1;
let TX_PAGE_SIZE = 50;
let TX_FILTER_EVENTS_BOUND = false;
let APP_CURRENCY = "AUD";
let BALANCE_ADJUST_EVENTS_BOUND = false;
let OVERVIEW_CACHE = new Map();
let BUDGET_CACHE = null;
let BUDGET_CACHE_AT = 0;

const OVERVIEW_CACHE_TTL_MS = 180000;
const BUDGET_CACHE_TTL_MS = 180000;

const INCOME_TYPES = new Set(["REVENUE"]);   // your org shows REVENUE
const EXPENSE_TYPES = new Set(["EXPENSE"]);  // your org shows EXPENSE
const BANK_TYPES = new Set(["BANK"]);        // your org shows BANK

function buildOverviewQueryString(todayStr, fyStartMonth = 7, cashBalance = null, burnMonths = null) {
  const params = new URLSearchParams();
  if (todayStr) params.set("today", todayStr);
  if (fyStartMonth) params.set("fy_start_month", String(fyStartMonth));
  if (cashBalance !== null && cashBalance !== "" && Number.isFinite(Number(cashBalance))) {
    params.set("cash_balance", String(cashBalance));
  }
  if (burnMonths !== null && burnMonths !== "" && Number.isFinite(Number(burnMonths))) {
    params.set("burn_months", String(burnMonths));
  }
  const qs = params.toString();
  return qs ? `?${qs}` : "";
}

function getCachedOverview(qs = "") {
  const entry = OVERVIEW_CACHE.get(qs || "");
  if (!entry) return null;
  if ((Date.now() - entry.cachedAt) > OVERVIEW_CACHE_TTL_MS) {
    OVERVIEW_CACHE.delete(qs || "");
    return null;
  }
  return entry.data;
}

function getCachedOverviewEntry(qs = "") {
  const entry = OVERVIEW_CACHE.get(qs || "");
  if (!entry) return null;
  if ((Date.now() - entry.cachedAt) > OVERVIEW_CACHE_TTL_MS) {
    OVERVIEW_CACHE.delete(qs || "");
    return null;
  }
  return entry;
}

function setCachedOverview(qs = "", data) {
  OVERVIEW_CACHE.set(qs || "", { data, cachedAt: Date.now() });
}

function clearOverviewCache() {
  OVERVIEW_CACHE.clear();
}

function getCachedBudget() {
  if (!BUDGET_CACHE) return null;
  if ((Date.now() - BUDGET_CACHE_AT) > BUDGET_CACHE_TTL_MS) {
    BUDGET_CACHE = null;
    BUDGET_CACHE_AT = 0;
    return null;
  }
  return BUDGET_CACHE;
}

function setCachedBudget(data) {
  BUDGET_CACHE = data;
  BUDGET_CACHE_AT = Date.now();
}

function clearBudgetCache() {
  BUDGET_CACHE = null;
  BUDGET_CACHE_AT = 0;
}

function selectedOverviewToday() {
  const fySelect = document.getElementById("fySelect");
  if (typeof fyEndDateFromYear !== "function") return null;

  let endYear = fySelect?.value;
  if (!endYear) {
    const now = new Date();
    endYear = String((now.getMonth() + 1) >= 7 ? now.getFullYear() + 1 : now.getFullYear());
  }

  return fyEndDateFromYear(endYear);
}

function applyBudgetUiState(data) {
  setRawData(data);
  const meta = document.getElementById("budgetMeta");
  const backendBadge = document.getElementById("budgetBackendBadge");
  const backend = String(data?.budget_backend || "--").toLowerCase();
  const source = data?.source || "--";
  if (meta) {
    meta.innerText = backend === "supabase"
      ? "Simple monthly budget saved to Supabase."
      : `Simple monthly budget saved to ${source}.`;
  }
  if (backendBadge) {
    backendBadge.textContent = backend === "supabase" ? "Supabase connected" : "Local budget";
  }
  renderBudgetRows(data?.rows || []);
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
  return rows.sort((a, b) => {
    const aTime = XeroTables.parseXeroDate(a.date)?.getTime?.() || 0;
    const bTime = XeroTables.parseXeroDate(b.date)?.getTime?.() || 0;
    return bTime - aTime;
  });
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
  // Use cash out (bank) for runway because it is closer to real cash burn.
  const cashBalance = Number(model?.kpis?.cash_balance_live ?? model?.kpis?.cash_balance_proxy ?? 0);

  const cashOutMonthly = (model?.charts?.cashflow?.cashOut || []).map(x => Number(x || 0));
  const avgCashOut = avgLastNMonths(cashOutMonthly, 3);

  const runwayMonths = avgCashOut > 0 ? (cashBalance / avgCashOut) : null;

  // Find the next tax-like liability with a due date.
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
    runway.textContent = "--";
  } else {
    runway.textContent = `${health.runwayMonths.toFixed(1)} months`;
  }

  if (health.nextTax) {
    const days = health.nextTax.due_in_days;
    const due = health.nextTax.due_date ? health.nextTax.due_date.toLocaleDateString() : "--";
    nextTax.textContent = `${health.nextTax.label} | ${due}${(days !== null ? ` (${days}d)` : "")}`;
  } else {
    nextTax.textContent = "--";
  }
}

function round2(x) { return Math.round(Number(x || 0) * 100) / 100; }

function fmtUSD(n) {
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
    valueEl.style.color = num >= 0 ? "#2f6e5f" : "#a85536";
  }
  if (metaEl) metaEl.innerText = suffix ? suffix.replace(/^\s*/, "") : metaEl.innerText;
}

function formatDelta(v, asCurrency = true) {
  if (!Number.isFinite(v)) return "--";
  const sign = v > 0 ? "+" : (v < 0 ? "-" : "=");
  const abs = Math.abs(v);
  const val = asCurrency ? fmtUSD(abs) : abs.toFixed(1);
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
  const data = (arr || []).map(v => (v === null || v === undefined ? null : Number(v || 0)));
  return data.map((v, i) => {
    if (v === null || Number.isNaN(v)) return null;
    if (Math.abs(v) > 0.0001) return v;
    const prev = i > 0 && data[i - 1] !== null ? Math.abs(data[i - 1]) : 0;
    const next = i < data.length - 1 && data[i + 1] !== null ? Math.abs(data[i + 1]) : 0;
    return (prev < 0.0001 && next < 0.0001) ? null : v;
  });
}

function cumulativeSeries(arr) {
  let total = 0;
  return (arr || []).map(v => {
    if (v === null || v === undefined || Number.isNaN(Number(v))) return null;
    total += Number(v || 0);
    return total;
  });
}

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
  if (!sales || !profit || !expenses) return;
  const cashflow = data?.charts?.cashflow;

  if (cashflow?.labels?.length && sales?.labels?.length && expenses?.labels?.length) {
    const revenueSeries = splitActualProjectedSeries(data, sales.labels, sales.actual_monthly || [], sales.projected_monthly || []);
    const expenseSeries = splitActualProjectedSeries(data, expenses.labels, expenses.actual_monthly || [], expenses.projected_monthly || []);
    let runningTotal = 0;
    const runningNet = revenueSeries.combined.map((revenueValue, idx) => {
      const expenseValue = expenseSeries.combined[idx];
      if (revenueValue === null || expenseValue === null) return null;
      runningTotal += Number(revenueValue || 0) - Number(expenseValue || 0);
      return runningTotal;
    });

    XeroCharts.renderChart("dashboardCashflow", "dashboardCashflowChart", "bar", {
      labels: monthInitialLabels(sales.labels),
      datasets: [
        {
          label: "Running Cash Flow",
          data: runningNet,
          backgroundColor: runningNet.map((v, idx) => {
            const isFuture = !isPastFinancialYearSelection(data) && idx > revenueSeries.cutoffIdx;
            if (Number(v || 0) < 0) return isFuture ? "rgba(236, 72, 153, 0.42)" : "rgba(236, 72, 153, 0.84)";
            return isFuture ? "rgba(59, 130, 246, 0.42)" : "rgba(59, 130, 246, 0.82)";
          }),
          borderRadius: 0,
          categoryPercentage: 0.62,
          barPercentage: 0.9
        }
      ]
    }, {
      plugins: { legend: { display: false } },
      scales: {
        x: { grid: { display: false } },
        y: { beginAtZero: true }
      }
    });
  }

  if (sales?.labels?.length && expenses?.labels?.length) {
    const revenueSeries = splitActualProjectedSeries(data, sales.labels, sales.actual_monthly || [], sales.projected_monthly || []);
    const expenseSeries = splitActualProjectedSeries(data, expenses.labels, expenses.actual_monthly || [], expenses.projected_monthly || []);

    XeroCharts.renderChart("dashboardRevenueExpenses", "dashboardRevenueExpensesChart", "line", {
      labels: monthInitialLabels(sales.labels),
      datasets: [
        {
          label: "Revenue",
          data: revenueSeries.actualOnly,
          borderColor: "#3b82f6",
          backgroundColor: "rgba(59, 130, 246, 0.18)",
          pointBackgroundColor: "#3b82f6",
          pointBorderColor: "#3b82f6",
          borderWidth: 3,
          pointRadius: 0,
          tension: 0.35
        },
        {
          label: "Revenue Projection",
          data: revenueSeries.projectedOnly,
          borderColor: "rgba(59, 130, 246, 0.55)",
          backgroundColor: "rgba(59, 130, 246, 0.08)",
          pointBackgroundColor: "rgba(59, 130, 246, 0.55)",
          pointBorderColor: "rgba(59, 130, 246, 0.55)",
          borderWidth: 2,
          borderDash: [7, 5],
          pointRadius: 0,
          tension: 0.35
        },
        {
          label: "Expenses",
          data: expenseSeries.actualOnly,
          borderColor: "#ec4899",
          backgroundColor: "rgba(236, 72, 153, 0.18)",
          pointBackgroundColor: "#ec4899",
          pointBorderColor: "#ec4899",
          borderWidth: 3,
          pointRadius: 0,
          tension: 0.35
        },
        {
          label: "Expenses Projection",
          data: expenseSeries.projectedOnly,
          borderColor: "rgba(236, 72, 153, 0.55)",
          backgroundColor: "rgba(236, 72, 153, 0.08)",
          pointBackgroundColor: "rgba(236, 72, 153, 0.55)",
          pointBorderColor: "rgba(236, 72, 153, 0.55)",
          borderWidth: 2,
          borderDash: [7, 5],
          pointRadius: 0,
          tension: 0.35
        }
      ]
    }, {
      interaction: {
        mode: "index",
        intersect: false
      },
      plugins: {
        legend: {
          display: false
        },
        tooltip: {
          enabled: true,
          backgroundColor: "rgba(15, 23, 42, 0.94)",
          titleColor: "#ffffff",
          bodyColor: "#e5e7eb",
          padding: 10,
          displayColors: true,
          callbacks: {
            label: (ctx) => {
              const label = ctx.dataset.label.replace(" Projection", "");
              const prefix = ctx.dataset.label.includes("Projection") ? "Projected " : "";
              return `${prefix}${label}: ${fmtUSD(Number(ctx.parsed?.y || 0))}`;
            }
          }
        }
      },
      scales: {
        x: { grid: { display: false } },
        y: { beginAtZero: true }
      }
    });
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

function sumNumeric(values) {
  return (values || []).reduce((total, value) => {
    const num = Number(value);
    return Number.isFinite(num) ? total + num : total;
  }, 0);
}

function parseCurrencyInput(value) {
  const cleaned = String(value || "").replace(/[^0-9.-]/g, "").trim();
  if (!cleaned) return NaN;
  return Number(cleaned);
}

function finiteNumberOrNaN(value) {
  if (value === null || value === undefined || value === "") return NaN;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : NaN;
}

function getBalanceOverrideStorageKey(data) {
  const orgId = document.getElementById("orgSelect")?.value || "default";
  const fyEnd = data?.meta?.fy_end ? String(data.meta.fy_end).slice(0, 4) : "current";
  return `mmxero.balanceOverride.${orgId}.${fyEnd}`;
}

function getBalanceOverrideValue(data) {
  try {
    const raw = window.localStorage.getItem(getBalanceOverrideStorageKey(data));
    if (raw === null || raw === "") return null;
    const parsed = Number(raw);
    return Number.isFinite(parsed) ? parsed : null;
  } catch (_) {
    return null;
  }
}

function setBalanceOverrideValue(data, value) {
  const key = getBalanceOverrideStorageKey(data);
  try {
    if (value === null || value === undefined || value === "") {
      window.localStorage.removeItem(key);
      return;
    }
    window.localStorage.setItem(key, String(Number(value)));
  } catch (_) {
    // ignore storage errors
  }
}

function computeYearProfitKpi(data) {
  const profitChart = data?.charts?.profit_fy || {};
  const currentYtdProfit = Number(profitChart.actual_ytd_profit);
  const previousYtdProfit = Number(profitChart.previous_year_ytd_profit);
  const monthlyProfit = profitChart.actual_monthly_profit || [];
  const previousYearMonthlyProfit = profitChart.previous_year_monthly_profit || [];
  const yearProfit = Number.isFinite(currentYtdProfit) ? currentYtdProfit : sumNumeric(monthlyProfit);
  const priorYearProfit = Number.isFinite(previousYtdProfit) ? previousYtdProfit : sumNumeric(previousYearMonthlyProfit);
  const changePct = Number.isFinite(yearProfit) && Number.isFinite(priorYearProfit) && Math.abs(priorYearProfit) > 0.0001
    ? ((yearProfit - priorYearProfit) / Math.abs(priorYearProfit)) * 100
    : NaN;
  return { yearProfit, priorYearProfit, changePct };
}

function computeBalanceKpi(data) {
  const isPastFy = isPastFinancialYearSelection(data);
  const liveBalance = finiteNumberOrNaN(data?.kpis?.cash_balance_live);
  const proxyBalance = finiteNumberOrNaN(data?.kpis?.cash_balance_proxy);
  const sourceBalance = Number.isFinite(liveBalance) ? liveBalance : proxyBalance;
  const manualOverride = isPastFy ? null : getBalanceOverrideValue(data);
  const hasManualOverride = Number.isFinite(manualOverride);
  const balance = hasManualOverride ? Number(manualOverride) : sourceBalance;
  const previousMonthBalance = finiteNumberOrNaN(data?.kpis?.cash_balance_prev_month);
  const balanceSeries = data?.charts?.cash_balance || {};
  const monthlyNet = (balanceSeries.monthly_net || []).map(v => finiteNumberOrNaN(v)).filter(v => Number.isFinite(v));
  const currentNet = monthlyNet.length ? Number(monthlyNet[monthlyNet.length - 1] || 0) : NaN;
  const previousBalance = Number.isFinite(previousMonthBalance)
    ? previousMonthBalance
    : (Number.isFinite(balance) && Number.isFinite(currentNet) ? balance - currentNet : NaN);
  const changePct = Number.isFinite(balance) && Number.isFinite(previousBalance) && Math.abs(previousBalance) > 0.0001
    ? ((balance - previousBalance) / Math.abs(previousBalance)) * 100
    : NaN;
  let source = "unavailable";
  if (hasManualOverride) source = "manual";
  else if (Number.isFinite(liveBalance)) source = "xero";
  else if (Number.isFinite(proxyBalance)) source = "proxy";
  return { balance, previousBalance, changePct, monthlyNet, hasManualOverride, source };
}

function computeForwardRunwayMetrics(data, startingBalance) {
  const balance = finiteNumberOrNaN(startingBalance);
  if (!Number.isFinite(balance)) {
    return { runwayMonths: NaN, avgMonthlyShortfall: NaN, basis: "unavailable", futureNet: [] };
  }

  const sales = data?.charts?.sales_fy || {};
  const expenses = data?.charts?.expenses_fy || {};
  const labels = sales.labels || expenses.labels || [];
  const revenueProjected = Array.isArray(sales.projected_monthly) ? sales.projected_monthly : [];
  const expenseProjected = Array.isArray(expenses.projected_monthly) ? expenses.projected_monthly : [];
  const asOfMonth = data?.meta?.as_of_month || (data?.meta?.today ? String(data.meta.today).slice(0, 7) : null);
  const cutoffIdx = asOfMonth ? labels.indexOf(asOfMonth) : -1;

  if (!labels.length || cutoffIdx < 0) {
    return { runwayMonths: NaN, avgMonthlyShortfall: NaN, basis: "unavailable", futureNet: [] };
  }

  const futureNet = labels
    .map((_, idx) => {
      const revenue = finiteNumberOrNaN(revenueProjected[idx]);
      const expense = finiteNumberOrNaN(expenseProjected[idx]);
      if (!Number.isFinite(revenue) || !Number.isFinite(expense)) return null;
      return revenue - expense;
    })
    .slice(cutoffIdx + 1)
    .filter((value) => value !== null);

  if (!futureNet.length) {
    return { runwayMonths: NaN, avgMonthlyShortfall: NaN, basis: "unavailable", futureNet: [] };
  }

  let rollingBalance = balance;
  let elapsedMonths = 0;
  for (const net of futureNet) {
    if (rollingBalance + net <= 0 && net < 0) {
      const monthFraction = rollingBalance <= 0 ? 0 : (rollingBalance / Math.abs(net));
      const avgMonthlyShortfall = Math.abs(net);
      return {
        runwayMonths: Math.max(0, elapsedMonths + monthFraction),
        avgMonthlyShortfall,
        basis: "budget",
        futureNet
      };
    }
    rollingBalance += net;
    elapsedMonths += 1;
  }

  const avgMonthlyNet = futureNet.reduce((total, net) => total + net, 0) / futureNet.length;
  if (avgMonthlyNet >= 0) {
    return {
      runwayMonths: Number.POSITIVE_INFINITY,
      avgMonthlyShortfall: NaN,
      basis: "budget-surplus",
      futureNet
    };
  }

  return {
    runwayMonths: elapsedMonths + (rollingBalance / Math.abs(avgMonthlyNet)),
    avgMonthlyShortfall: Math.abs(avgMonthlyNet),
    basis: "budget-average",
    futureNet
  };
}

function buildSparklineMarkup(values) {
  const points = (values || [])
    .map(v => Number(v))
    .filter(v => Number.isFinite(v));
  if (points.length < 2) return "";

  const width = 120;
  const height = 42;
  const pad = 3;
  const min = Math.min(...points);
  const max = Math.max(...points);
  const range = max - min || 1;
  const step = points.length > 1 ? (width - pad * 2) / (points.length - 1) : 0;
  const coords = points.map((value, index) => {
    const x = pad + step * index;
    const y = height - pad - (((value - min) / range) * (height - pad * 2));
    return `${x.toFixed(2)},${y.toFixed(2)}`;
  }).join(" ");

  return `
    <svg viewBox="0 0 ${width} ${height}" preserveAspectRatio="none" role="presentation">
      <polyline
        points="${coords}"
        fill="none"
        stroke="currentColor"
        stroke-width="2.6"
        stroke-linecap="round"
        stroke-linejoin="round"
      ></polyline>
    </svg>
  `;
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

function maskFutureSeries(data, labels, values, fillValue = null) {
  const series = Array.isArray(values) ? values.slice() : [];
  if (isPastFinancialYearSelection(data)) return series;
  const asOfMonth = data?.meta?.as_of_month || (data?.meta?.today ? String(data.meta.today).slice(0, 7) : null);
  const cutoffIdx = asOfMonth ? (labels || []).indexOf(asOfMonth) : -1;
  if (cutoffIdx < 0) return series;
  return series.map((value, idx) => (idx > cutoffIdx ? fillValue : value));
}

function splitActualProjectedSeries(data, labels, actualValues, projectedValues) {
  const actual = Array.isArray(actualValues) ? actualValues.slice() : [];
  const projected = Array.isArray(projectedValues) ? projectedValues.slice() : [];
  if (isPastFinancialYearSelection(data)) {
    return {
      cutoffIdx: labels.length - 1,
      actualOnly: actual,
      projectedOnly: labels.map(() => null),
      combined: actual
    };
  }

  const asOfMonth = data?.meta?.as_of_month || (data?.meta?.today ? String(data.meta.today).slice(0, 7) : null);
  const cutoffIdx = asOfMonth ? (labels || []).indexOf(asOfMonth) : -1;
  if (cutoffIdx < 0) {
    return {
      cutoffIdx: labels.length - 1,
      actualOnly: actual,
      projectedOnly: labels.map(() => null),
      combined: actual
    };
  }

  return {
    cutoffIdx,
    actualOnly: labels.map((_, idx) => (idx > cutoffIdx ? null : actual[idx] ?? null)),
    projectedOnly: labels.map((_, idx) => {
      if (idx < cutoffIdx) return null;
      if (idx === cutoffIdx) return actual[idx] ?? projected[idx] ?? null;
      return projected[idx] ?? null;
    }),
    combined: labels.map((_, idx) => (idx <= cutoffIdx ? (actual[idx] ?? null) : (projected[idx] ?? null)))
  };
}

function selectedFyLabelFromUiOrData(data) {
  const fySelect = document.getElementById("fySelect");
  const optionText = fySelect?.selectedOptions?.[0]?.textContent?.trim();
  if (optionText && optionText !== "Fiscal Year") return optionText;
  const fyEndYear = data?.meta?.fy_end ? Number(String(data.meta.fy_end).slice(0, 4)) : NaN;
  return Number.isFinite(fyEndYear) ? `FY ${fyEndYear - 1}-${fyEndYear}` : "FY --";
}

function isPastFinancialYearSelection(data) {
  const fyEndYear = data?.meta?.fy_end ? Number(String(data.meta.fy_end).slice(0, 4)) : NaN;
  const fyStartMonth = data?.meta?.fy_start ? Number(String(data.meta.fy_start).slice(5, 7)) : 7;
  if (!Number.isFinite(fyEndYear)) return false;
  const now = new Date();
  const nowMonth = now.getMonth() + 1;
  const currentFyEndYear = nowMonth >= fyStartMonth ? now.getFullYear() + 1 : now.getFullYear();
  return fyEndYear < currentFyEndYear;
}

function renderEmptyView(containerId, title, message) {
  const container = document.getElementById(containerId);
  if (!container) return;
  container.innerHTML = `
    <section class="rebuilt-dashboard">
      <section class="rebuilt-panel">
        <h3 class="rebuilt-panel-title">${escapeHtmlText(title)}</h3>
        <div class="rebuilt-empty" style="padding: 10px 0 4px; text-align: left;">
          ${escapeHtmlText(message)}
        </div>
      </section>
    </section>
  `;
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

  // Explicit do-not-estimate buckets.
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
  if (!(d instanceof Date) || isNaN(d.getTime())) return "--";
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
    // We still track totals even if rule is null, but no due date is estimated.

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

window.clearBudgetCache = clearBudgetCache;
window.clearOverviewCache = clearOverviewCache;
