let JOURNAL_CACHE = null;
let JOURNAL_LINES = null;
let FILTERED_JOURNAL_LINES = null;
let TX_CURRENT_PAGE = 1;
let TX_PAGE_SIZE = 100;
let APP_CURRENCY = "AUD";

const INCOME_TYPES = new Set(["REVENUE"]);   // your org shows REVENUE
const EXPENSE_TYPES = new Set(["EXPENSE"]);  // your org shows EXPENSE
const BANK_TYPES = new Set(["BANK"]);        // your org shows BANK

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
  // Use cash out (bank) for runway because it is closer to real cash burn.
  const cashBalance = Number(model?.kpis?.cash_balance_proxy || 0);

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

  const labels = sales.labels || [];
  const salesActual = SALES_MODE === "cumulative" ? sales.actual_cumulative : sales.actual_monthly;
  const expenseActual = SALES_MODE === "cumulative" ? expenses.actual_cumulative : expenses.actual_monthly;
  const netActual = SALES_MODE === "cumulative"
    ? cumulativeSeries((profit.actual_monthly_profit || []).map(v => Number(v || 0)))
    : (profit.actual_monthly_profit || []).map(v => Number(v || 0));

  XeroCharts.renderChart("overviewPerformance", "overviewPerformanceChart", "bar", {
    labels: profit.labels || labels,
    datasets: [
      {
        type: "bar",
        label: "Sales",
        data: seriesWithLessZeroNoise(salesActual),
        borderColor: "#0f766e",
        backgroundColor: "rgba(15, 118, 110, 0.72)",
        borderWidth: 1,
        borderRadius: 8,
        barThickness: 18
      },
      {
        type: "bar",
        label: "Expenses",
        data: seriesWithLessZeroNoise(expenseActual),
        borderColor: "#b91c1c",
        backgroundColor: "rgba(185, 28, 28, 0.72)",
        borderWidth: 1,
        borderRadius: 8,
        barThickness: 18
      },
      {
        type: "line",
        label: "Net Profit",
        data: seriesWithLessZeroNoise(netActual || []),
        borderColor: "#2563eb",
        borderWidth: 3,
        pointRadius: 4,
        pointHoverRadius: 6,
        pointBackgroundColor: (netActual || []).map(v => Number(v || 0) >= 0 ? "#16a34a" : "#dc2626"),
        pointBorderColor: "#ffffff",
        pointBorderWidth: 2,
        tension: 0.3,
        spanGaps: true
      }
    ]
  }, {
    interaction: {
      mode: "index",
      intersect: false
    },
    scales: {
      x: {
        grid: { display: false }
      },
      y: {
        beginAtZero: true
      }
    }
  });
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

function sumNumeric(values) {
  return (values || []).reduce((total, value) => {
    const num = Number(value);
    return Number.isFinite(num) ? total + num : total;
  }, 0);
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

function selectedCompanyName() {
  const select = document.getElementById("orgSelect");
  const option = select?.selectedOptions?.[0];
  const name = option?.textContent?.trim();
  return name || "Company";
}

async function renderDashboardRecentTransactions() {
  const body = document.getElementById("dashboardRecentTransactionsBody");
  if (!body) return;

  try {
    const journals = await getJournals();
    const rows = flattenJournalLines(journals);
    const now = new Date();
    const cutoff = new Date(now);
    cutoff.setDate(cutoff.getDate() - 31);

    const recent = rows
      .filter(row => {
        const d = XeroTables.parseXeroDate(row.date);
        return d instanceof Date && !Number.isNaN(d.getTime()) && d >= cutoff;
      })
      .sort((a, b) => XeroTables.parseXeroDate(b.date) - XeroTables.parseXeroDate(a.date))
      .slice(0, 8);

    if (!recent.length) {
      body.innerHTML = `<tr><td colspan="4" class="rebuilt-empty">No journal lines in the past month.</td></tr>`;
      return;
    }

    body.innerHTML = recent.map(row => `
      <tr>
        <td>${escapeHtmlText(XeroTables.formatDate(row.date))}</td>
        <td>${escapeHtmlText(`${row.accountCode || ""} ${row.accountName || ""}`.trim() || "General")}</td>
        <td>${escapeHtmlText(row.description || "--")}</td>
        <td>${escapeHtmlText(XeroTables.formatCurrency(Math.abs(Number(row.net || 0)), APP_CURRENCY))}</td>
      </tr>
    `).join("");
  } catch (_) {
    body.innerHTML = `<tr><td colspan="4" class="rebuilt-empty">Unable to load recent transactions.</td></tr>`;
  }
}

function renderOverview(data) {
  const kpis = data?.kpis || {};
  setAppCurrency(data?.meta?.currency);
  populateFySelect(data);
  const deltas = computeProfitDeltas(data);
  const yearProfitKpi = computeYearProfitKpi(data);
  const companyName = selectedCompanyName();
  const greeting = document.getElementById("dashboardGreeting");
  if (greeting) greeting.textContent = `Hi, ${companyName}`;

  const fyEndYear = data?.meta?.fy_end ? Number(String(data.meta.fy_end).slice(0, 4)) : null;
  const profitLabel = document.getElementById("dashboardProfitLabel");
  if (profitLabel) {
    profitLabel.textContent = Number.isFinite(fyEndYear) ? `Profit ${fyEndYear - 1}-${fyEndYear}` : "Profit";
  }

  const profitValue = document.getElementById("dashboardProfitValue");
  if (profitValue) {
    profitValue.classList.remove("positive", "negative");
    profitValue.textContent = Number.isFinite(yearProfitKpi.yearProfit) ? fmtUSD(yearProfitKpi.yearProfit) : "--";
    if (Number.isFinite(yearProfitKpi.yearProfit)) {
      profitValue.classList.add(yearProfitKpi.yearProfit < 0 ? "negative" : "positive");
    }
  }

  const profitTrend = document.getElementById("dashboardProfitTrend");
  if (profitTrend) {
    profitTrend.classList.remove("up", "down", "flat");
    if (Number.isFinite(yearProfitKpi.changePct)) {
      const direction = yearProfitKpi.changePct > 0 ? "up" : (yearProfitKpi.changePct < 0 ? "down" : "flat");
      const arrow = yearProfitKpi.changePct > 0 ? "▲" : (yearProfitKpi.changePct < 0 ? "▼" : "•");
      profitTrend.textContent = `${arrow} ${Math.round(Math.abs(yearProfitKpi.changePct))}% vs PY`;
      profitTrend.classList.add(direction);
      profitTrend.textContent = `${direction === "up" ? "+" : (direction === "down" ? "-" : "=")} ${Math.round(Math.abs(yearProfitKpi.changePct))}% vs PY`;
    } else {
      profitTrend.textContent = "--";
      profitTrend.classList.add("flat");
    }
  }

  const profitSparkline = document.getElementById("dashboardProfitSparkline");
  if (profitSparkline) {
    const profitSeries = data?.charts?.profit_fy?.actual_monthly_profit || [];
    const cumulativeProfitSeries = cumulativeSeries(profitSeries);
    profitSparkline.innerHTML = buildSparklineMarkup(cumulativeProfitSeries);
  }

  const balanceValue = document.getElementById("dashboardBalanceValue");
  if (balanceValue) {
    const balance = Number(kpis.cash_balance_proxy);
    balanceValue.classList.remove("positive", "negative");
    balanceValue.textContent = Number.isFinite(balance) ? fmtUSD(balance) : "--";
    if (Number.isFinite(balance)) {
      balanceValue.classList.add(balance < 0 ? "negative" : "positive");
    }
  }

  const balanceTrend = document.getElementById("dashboardBalanceTrend");
  if (balanceTrend) balanceTrend.textContent = Number.isFinite(deltas.profitNowDelta) ? formatDelta(deltas.profitNowDelta) : "--";

  const runwayValue = document.getElementById("dashboardRunwayValue");
  if (runwayValue) {
    const runwayMonths = Number(kpis.runway_months);
    runwayValue.classList.remove("positive", "negative");
    runwayValue.textContent = Number.isFinite(runwayMonths) ? `${Math.round(runwayMonths)} Months` : "--";
    if (Number.isFinite(runwayMonths)) {
      runwayValue.classList.add(runwayMonths <= 3 ? "negative" : "positive");
    }
  }

  const burnNote = document.getElementById("dashboardBurnNote");
  if (burnNote) {
    const burn = Number(kpis.monthly_burn || 0);
    burnNote.textContent = Number.isFinite(burn) && burn > 0 ? `At ${fmtUSD(burn)} per month` : "--";
  }

  const cashflow = data?.charts?.cashflow;
  if (cashflow?.labels?.length) {
    XeroCharts.renderChart("dashboardCashflow", "dashboardCashflowChart", "bar", {
      labels: cashflow.labels,
      datasets: [
        {
          label: "Cash In",
          data: cashflow.cashIn || [],
          backgroundColor: "rgba(59, 130, 246, 0.82)",
          borderRadius: 6
        },
        {
          label: "Cash Out",
          data: (cashflow.cashOut || []).map(v => Number(v || 0) * -1),
          backgroundColor: "rgba(236, 72, 153, 0.78)",
          borderRadius: 6
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

  const sales = data?.charts?.sales_fy;
  const expenses = data?.charts?.expenses_fy;
  if (sales?.labels?.length && expenses?.labels?.length) {
    XeroCharts.renderChart("dashboardRevenueExpenses", "dashboardRevenueExpensesChart", "line", {
      labels: sales.labels,
      datasets: [
        {
          label: "Revenue",
          data: sales.actual_monthly || [],
          borderColor: "#3b82f6",
          backgroundColor: "rgba(59, 130, 246, 0.18)",
          borderWidth: 3,
          pointRadius: 0,
          tension: 0.35
        },
        {
          label: "Expenses",
          data: expenses.actual_monthly || [],
          borderColor: "#ec4899",
          backgroundColor: "rgba(236, 72, 153, 0.18)",
          borderWidth: 3,
          pointRadius: 0,
          tension: 0.35
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

  renderDashboardRecentTransactions();
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

// ---------- Liability due estimates ----------
function renderLiabilitySummary(rows) {
  const kpiCurLiab = document.getElementById("kpiCurLiab");
  const kpiTaxLiab = document.getElementById("kpiTaxLiab");
  const kpiOtherLiab = document.getElementById("kpiOtherLiab");
  const th = document.getElementById("liabHeader");
  const tb = document.getElementById("liabBody");
  if (!kpiCurLiab || !kpiTaxLiab || !kpiOtherLiab || !th || !tb) {
    renderEmptyView("liabilitiesContainer", "Upcoming Risks", "This screen has been cleared and is ready to rebuild.");
    return;
  }

  const totalCur = rows.reduce((a, r) => a + Number(r.outstanding || 0), 0);
  const dueSoon = rows
    .filter(r => r.status === "Due soon" || r.status === "Overdue")
    .reduce((a, r) => a + Number(r.outstanding || 0), 0);
  const other = Math.max(0, totalCur - dueSoon);

  kpiCurLiab.innerText = fmtUSD(totalCur);
  kpiTaxLiab.innerText = fmtUSD(dueSoon);
  kpiOtherLiab.innerText = fmtUSD(other);

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
  setLoading("Building risk insights...");

  try {
    renderEmptyView("liabilitiesContainer", "Upcoming Risks", "This screen is not rebuilt yet.");
    stopLoading();
    document.getElementById("liabilitiesContainer").style.display = "block";
    return;

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

const BUDGET_ACCOUNT_OPTIONS = {
  REVENUE: ["Sales", "Services", "Other income", "Custom"],
  EXPENSE: ["Wages", "Rent", "Marketing", "Software", "Travel", "Other", "Custom"]
};
let BUDGET_ROW_SEQ = 1;

function budgetAccountOptions(type) {
  return BUDGET_ACCOUNT_OPTIONS[String(type || "EXPENSE").toUpperCase()] || BUDGET_ACCOUNT_OPTIONS.EXPENSE;
}

function nextBudgetRowId() {
  const id = `budget-row-${BUDGET_ROW_SEQ}`;
  BUDGET_ROW_SEQ += 1;
  return id;
}

function escapeAttr(value) {
  return escapeHtmlText(value).replaceAll("`", "&#096;");
}

function budgetRowDerivedValues(rowOrState) {
  const accountType = String(rowOrState.accountType || "").toUpperCase();
  const enteredAmount = Math.abs(Number(rowOrState.enteredAmount || 0));
  const isTaxableSale = accountType === "REVENUE";
  const gstAmount = isTaxableSale ? round2(enteredAmount * 0.1) : 0;
  const grossAmount = round2(enteredAmount + gstAmount);
  return { gstAmount, grossAmount, isTaxableSale };
}

function budgetRowHtml(row = {}, idx = 0) {
  const dateValue = String(row.JOURNAL_DATE || row.journal_date || "").slice(0, 10);
  const typeValue = String(row.ACCOUNT_TYPE || row.account_type || "EXPENSE").toUpperCase();
  const nameValue = String(row.ACCOUNT_NAME || row.account_name || "");
  const rowId = String(row.ROW_ID || row.row_id || nextBudgetRowId());
  const generatedFrom = String(row.GENERATED_FROM || row.generated_from || "");
  const repeatValue = String(row.REPEAT || row.repeat || "ONE_OFF").toUpperCase();
  let amountValue = Number(row.DISPLAY_AMOUNT ?? row.display_amount ?? row.NET_AMOUNT ?? row.net_amount ?? 0);
  if (typeValue === "REVENUE") amountValue = Math.abs(amountValue);
  const options = budgetAccountOptions(typeValue);
  const matchesPreset = options.some(option => option.toLowerCase() === nameValue.toLowerCase() && option !== "Custom");
  const selectedName = matchesPreset ? options.find(option => option.toLowerCase() === nameValue.toLowerCase()) : (nameValue ? "Custom" : options[0]);
  const customVisible = selectedName === "Custom";
  const derived = budgetRowDerivedValues({
    accountType: typeValue,
    accountName: customVisible ? nameValue : selectedName,
    enteredAmount: amountValue
  });

  return `
    <tr data-budget-idx="${idx}" data-row-id="${escapeAttr(rowId)}" data-generated-from="${escapeAttr(generatedFrom)}">
      <td><input type="date" class="budget-date budget-input" value="${dateValue}"></td>
      <td>
        <select class="budget-type budget-select" onchange="updateBudgetRowUi(${idx})">
          <option value="REVENUE" ${typeValue === "REVENUE" ? "selected" : ""}>REVENUE</option>
          <option value="EXPENSE" ${typeValue === "EXPENSE" ? "selected" : ""}>EXPENSE</option>
        </select>
      </td>
      <td>
        <select class="budget-name-select budget-select" onchange="updateBudgetRowUi(${idx})">
          ${options.map(option => `<option value="${escapeAttr(option)}" ${option === selectedName ? "selected" : ""}>${escapeHtmlText(option)}</option>`).join("")}
        </select>
        <input type="text" class="budget-name budget-input budget-custom-name" value="${customVisible ? escapeAttr(nameValue) : ""}" placeholder="Custom account name" style="${customVisible ? "" : "display:none;"}">
      </td>
      <td><input type="number" class="budget-amount budget-input" value="${Number.isFinite(amountValue) ? amountValue : 0}" step="0.01" oninput="updateBudgetRowUi(${idx})"></td>
      <td>
        <select class="budget-repeat budget-select" onchange="updateBudgetRowUi(${idx})">
          <option value="ONE_OFF" ${repeatValue === "ONE_OFF" ? "selected" : ""}>One-off</option>
          <option value="MONTHLY" ${repeatValue === "MONTHLY" ? "selected" : ""}>Monthly</option>
          <option value="QUARTERLY" ${repeatValue === "QUARTERLY" ? "selected" : ""}>Quarterly</option>
        </select>
      </td>
      <td><div class="budget-metric"><small>End</small><span>This FY</span></div></td>
      <td><div class="budget-metric budget-gst"><small>GST (10%)</small><span class="budget-gst-value">${derived.isTaxableSale ? fmtUSD(derived.gstAmount) : "—"}</span></div></td>
      <td><div class="budget-metric budget-gross"><small>Total</small><span class="budget-gross-value">${Number.isFinite(amountValue) ? fmtUSD(derived.grossAmount) : "—"}</span></div></td>
      <td>
        <div style="display:flex; gap:8px; flex-wrap:wrap;">
          <button type="button" class="btn-muted" onclick="copyBudgetFromPrevious(${idx})">Use previous month</button>
          <button type="button" class="btn-muted" onclick="applyBudgetRepeat(${idx})">Apply repeat</button>
          <button type="button" class="btn-muted" onclick="removeBudgetRow(${idx})">Delete</button>
        </div>
      </td>
    </tr>`;
}

function budgetRowStateFromElement(tr) {
  const accountType = tr.querySelector(".budget-type")?.value || "";
  const selectedName = tr.querySelector(".budget-name-select")?.value || "";
  const customInput = tr.querySelector(".budget-name");
  const accountName = selectedName === "Custom"
    ? (customInput?.value || "").trim()
    : selectedName;
  const journalDate = tr.querySelector(".budget-date")?.value || "";
  const enteredAmount = Math.abs(Number(tr.querySelector(".budget-amount")?.value || 0));
  const repeat = tr.querySelector(".budget-repeat")?.value || "ONE_OFF";
  const rowId = tr.dataset.rowId || nextBudgetRowId();
  const generatedFrom = tr.dataset.generatedFrom || "";
  return { accountType, accountName, journalDate, enteredAmount, selectedName, repeat, rowId, generatedFrom };
}

function collectBudgetUiRowsFromTable() {
  const body = document.getElementById("budgetBody");
  if (!body) return [];
  return Array.from(body.querySelectorAll("tr")).map(tr => {
    const state = budgetRowStateFromElement(tr);
    return {
      ROW_ID: state.rowId,
      GENERATED_FROM: state.generatedFrom,
      REPEAT: state.repeat,
      ACCOUNT_TYPE: state.accountType,
      ACCOUNT_NAME: state.accountName,
      JOURNAL_DATE: state.journalDate,
      DISPLAY_AMOUNT: state.enteredAmount
    };
  });
}

function collectBudgetRowsFromTable() {
  return collectBudgetUiRowsFromTable().map(row => {
    const accountType = row.ACCOUNT_TYPE || "";
    const accountName = row.ACCOUNT_NAME || "";
    const journalDate = row.JOURNAL_DATE || "";
    const enteredAmount = Number(row.DISPLAY_AMOUNT || 0);
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

function budgetFyEndDate(dateStr) {
  if (!dateStr) return null;
  const dt = new Date(`${dateStr}T00:00:00`);
  if (Number.isNaN(dt.getTime())) return null;
  const fyEndYear = dt.getMonth() >= 6 ? dt.getFullYear() + 1 : dt.getFullYear();
  return new Date(fyEndYear, 5, 30);
}

function shiftDateString(dateStr, monthsToAdd) {
  if (!dateStr) return "";
  const dt = new Date(`${dateStr}T00:00:00`);
  if (Number.isNaN(dt.getTime())) return "";
  const shifted = new Date(dt.getFullYear(), dt.getMonth() + monthsToAdd, 1);
  const mm = String(shifted.getMonth() + 1).padStart(2, "0");
  const dd = String(Math.min(dt.getDate(), new Date(shifted.getFullYear(), shifted.getMonth() + 1, 0).getDate())).padStart(2, "0");
  return `${shifted.getFullYear()}-${mm}-${dd}`;
}

function updateBudgetSummary() {
  const rows = collectBudgetRowsFromTable();
  const rowCountEl = document.getElementById("budgetRowsCount");
  const revenueEl = document.getElementById("budgetRevenueTotal");
  const gstEl = document.getElementById("budgetGstTotal");
  const revenueRows = rows.filter(row => row.ACCOUNT_TYPE === "REVENUE");
  const revenueTotal = revenueRows.reduce((sum, row) => sum + Math.abs(Number(row.NET_AMOUNT || 0)), 0);
  const gstTotal = revenueRows.reduce((sum, row) => {
    return sum + (Math.abs(Number(row.NET_AMOUNT || 0)) * 0.1);
  }, 0);
  if (rowCountEl) rowCountEl.innerText = String(rows.length);
  if (revenueEl) revenueEl.innerText = fmtUSD(revenueTotal);
  if (gstEl) gstEl.innerText = fmtUSD(gstTotal);
}

function updateBudgetRowUi(idx) {
  const body = document.getElementById("budgetBody");
  if (!body) return;
  const tr = body.querySelector(`tr[data-budget-idx="${idx}"]`);
  if (!tr) return;

  const typeEl = tr.querySelector(".budget-type");
  const selectEl = tr.querySelector(".budget-name-select");
  const customInput = tr.querySelector(".budget-name");
  const currentType = typeEl?.value || "EXPENSE";
  const options = budgetAccountOptions(currentType);
  const currentSelected = selectEl?.value || "";
  const currentCustom = customInput?.value || "";
  const keepExisting = options.includes(currentSelected) ? currentSelected : "Custom";

  if (selectEl) {
    selectEl.innerHTML = options
      .map(option => `<option value="${escapeAttr(option)}" ${option === keepExisting ? "selected" : ""}>${escapeHtmlText(option)}</option>`)
      .join("");
  }
  if (customInput) {
    customInput.style.display = keepExisting === "Custom" ? "" : "none";
    if (keepExisting !== "Custom") customInput.value = "";
    else customInput.value = currentCustom;
  }

  const state = budgetRowStateFromElement(tr);
  const derived = budgetRowDerivedValues(state);
  const gstValue = tr.querySelector(".budget-gst-value");
  const grossValue = tr.querySelector(".budget-gross-value");
  if (gstValue) gstValue.textContent = derived.isTaxableSale ? fmtUSD(derived.gstAmount) : "—";
  if (grossValue) grossValue.textContent = fmtUSD(derived.grossAmount);
  updateBudgetSummary();
}

function syncBudgetRowsUi() {
  const body = document.getElementById("budgetBody");
  if (!body) return;
  Array.from(body.querySelectorAll("tr")).forEach((tr, idx) => {
    tr.dataset.budgetIdx = String(idx);
    const customInput = tr.querySelector(".budget-name");
    if (customInput) {
      customInput.oninput = () => updateBudgetRowUi(idx);
    }
    updateBudgetRowUi(idx);
  });
}

function copyBudgetFromPrevious(idx) {
  const rows = collectBudgetUiRowsFromTable();
  if (idx <= 0 || idx >= rows.length) return;
  const prev = rows[idx - 1];
  const current = rows[idx];
  rows[idx] = {
    ...current,
    ACCOUNT_TYPE: prev.ACCOUNT_TYPE,
    ACCOUNT_NAME: prev.ACCOUNT_NAME,
    DISPLAY_AMOUNT: prev.DISPLAY_AMOUNT,
    REPEAT: prev.REPEAT,
    JOURNAL_DATE: current.JOURNAL_DATE || shiftDateString(prev.JOURNAL_DATE, 1)
  };
  renderBudgetRows(rows);
}

function applyBudgetRepeat(idx) {
  const rows = collectBudgetUiRowsFromTable();
  const source = rows[idx];
  if (!source) return;
  if (!source.JOURNAL_DATE || !source.ACCOUNT_NAME) {
    showError("Add a month and account name before applying repeat.");
    return;
  }
  const step = source.REPEAT === "QUARTERLY" ? 3 : source.REPEAT === "MONTHLY" ? 1 : 0;
  if (!step) return;

  const sourceId = source.ROW_ID || nextBudgetRowId();
  source.ROW_ID = sourceId;
  const remaining = rows.filter(row => row.GENERATED_FROM !== sourceId);
  const fyEnd = budgetFyEndDate(source.JOURNAL_DATE);
  if (!fyEnd) {
    renderBudgetRows(remaining);
    return;
  }

  let nextDate = shiftDateString(source.JOURNAL_DATE, step);
  while (nextDate) {
    const nextDt = new Date(`${nextDate}T00:00:00`);
    if (Number.isNaN(nextDt.getTime()) || nextDt > fyEnd) break;
    remaining.push({
      ROW_ID: nextBudgetRowId(),
      GENERATED_FROM: sourceId,
      REPEAT: "ONE_OFF",
      ACCOUNT_TYPE: source.ACCOUNT_TYPE,
      ACCOUNT_NAME: source.ACCOUNT_NAME,
      JOURNAL_DATE: nextDate,
      DISPLAY_AMOUNT: source.DISPLAY_AMOUNT
    });
    nextDate = shiftDateString(nextDate, step);
  }
  renderBudgetRows(remaining);
}

function renderBudgetRows(rows) {
  const body = document.getElementById("budgetBody");
  if (!body) return;
  if (!rows || !rows.length) {
    body.innerHTML = budgetRowHtml({}, 0);
    syncBudgetRowsUi();
    return;
  }
  body.innerHTML = rows.map((row, idx) => budgetRowHtml(row, idx)).join("");
  syncBudgetRowsUi();
}

async function loadBudgetRows() {
  if (!document.getElementById("budgetBody")) {
    renderEmptyView("budgetContainer", "Budget Input", "This screen is not rebuilt yet.");
    stopLoading();
    return null;
  }
  setLoading("Loading budget workspace...");
  try {
    const data = await XeroAPI.fetch_json("/api/budget");
    setRawData(data);
    const meta = document.getElementById("budgetMeta");
    if (meta) {
      meta.innerText = `Revenue stays net of GST; revenue rows show a 10% GST preview. Source: ${data.source || "--"}`;
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
  setLoading("Saving budget changes...");
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
  const rows = collectBudgetUiRowsFromTable();
  rows.push({ ROW_ID: nextBudgetRowId(), REPEAT: "ONE_OFF" });
  renderBudgetRows(rows);
}

function removeBudgetRow(idx) {
  const rows = collectBudgetUiRowsFromTable();
  const target = rows[idx];
  if (!target) return;
  const remaining = rows.filter((row, rowIdx) => {
    if (rowIdx === idx) return false;
    if (target.ROW_ID && row.GENERATED_FROM === target.ROW_ID) return false;
    return true;
  });
  renderBudgetRows(remaining);
}

async function showBudgetInput() {
  hideAllViews();
  document.getElementById("budgetContainer").style.display = "block";
  if (!document.getElementById("budgetBody")) {
    renderEmptyView("budgetContainer", "Budget Input", "This screen is not rebuilt yet.");
    return;
  }
  await loadBudgetRows();
}

window.showBudgetInput = showBudgetInput;
window.loadBudgetRows = loadBudgetRows;
window.saveBudgetRows = saveBudgetRows;
window.addBudgetRow = addBudgetRow;
window.removeBudgetRow = removeBudgetRow;
window.updateBudgetRowUi = updateBudgetRowUi;
window.copyBudgetFromPrevious = copyBudgetFromPrevious;
window.applyBudgetRepeat = applyBudgetRepeat;

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
  const kpiCash = document.getElementById("kpiCash");
  const kpiRevenue = document.getElementById("kpiRevenue");
  const kpiExpenses = document.getElementById("kpiExpenses");
  const kpiProfit = document.getElementById("kpiProfit");
  const kpiAR = document.getElementById("kpiAR");
  const kpiAP = document.getElementById("kpiAP");
  const out = document.getElementById("bigOutflows");
  if (!kpiCash || !kpiRevenue || !kpiExpenses || !kpiProfit || !kpiAR || !kpiAP || !out) return;

  kpiCash.innerText = fmtUSD(model.kpis.cash_balance_proxy);
  kpiRevenue.innerText = fmtUSD(model.kpis.monthly_revenue);
  kpiExpenses.innerText = fmtUSD(model.kpis.monthly_expenses);
  kpiProfit.innerText = fmtUSD(model.kpis.monthly_profit);

  // journal-only placeholders
  kpiAR.innerText = "--";
  kpiAP.innerText = "--";

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
  setLoading("Preparing dashboard...");

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
  setLoading("Loading transactions...");
  try {
    if (!document.getElementById("tableHeader") || !document.getElementById("tableBody")) {
      renderEmptyView("transactionsContainer", "Transactions", "This screen is not rebuilt yet.");
      stopLoading();
      document.getElementById("transactionsContainer").style.display = "block";
      return;
    }

    const journals = await getJournals();
    JOURNAL_LINES = flattenJournalLines(journals);
    populateTransactionTypeFilter(JOURNAL_LINES);

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




