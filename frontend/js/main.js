let currentData = null;
let showingRaw = false;

let JOURNAL_CACHE = null;
let JOURNAL_LINES = null;

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
  ["dashboardContainer","transactionsContainer","liabilitiesContainer","rawOutput"].forEach(id => {
    const el = document.getElementById(id);
    if (el) el.style.display = "none";
  });
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
  // Use CASH OUT (bank) for runway because it’s closer to real cash burn
  const cashBalance = Number(model?.kpis?.cash_balance_proxy || 0);

  const cashOutMonthly = (model?.charts?.cashflow?.cashOut || []).map(x => Number(x || 0));
  const avgCashOut = avgLastNMonths(cashOutMonthly, 3);

  const runwayMonths = avgCashOut > 0 ? (cashBalance / avgCashOut) : null;

  // Find next “tax-like” liability with a due date
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
    text = `${text} • ${nextTax.label} due soon`;
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
    runway.textContent = "—";
  } else {
    runway.textContent = `${health.runwayMonths.toFixed(1)} months`;
  }

  if (health.nextTax) {
    const days = health.nextTax.due_in_days;
    const due = health.nextTax.due_date ? health.nextTax.due_date.toLocaleDateString() : "—";
    nextTax.textContent = `${health.nextTax.label} • ${due}${(days !== null ? ` (${days}d)` : "")}`;
  } else {
    nextTax.textContent = "—";
  }
}

function round2(x) { return Math.round(Number(x || 0) * 100) / 100; }

function fmtUSD(n) {
  const v = Number(n || 0);
  return v.toLocaleString(undefined, { style: "currency", currency: "USD" });
}

function setRawData(data) {
  currentData = data;
  const raw = document.getElementById("rawOutput");
  if (raw) raw.innerText = JSON.stringify(data, null, 2);
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

  // Explicit “do not estimate”
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
  if (!(d instanceof Date) || isNaN(d.getTime())) return "—";
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
    // We still track totals even if rule is null (but due date will be —)

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
function renderLiabilitiesTables(rows) {
  // Split rows into "tax with estimated due" vs "other"
  const TAX_BUCKETS = new Set(["GST","PAYG","SUPER","INCOME_TAX","WAGES"]);

  const taxRows = rows.filter(r => TAX_BUCKETS.has(r.bucket));
  const otherRows = rows.filter(r => !TAX_BUCKETS.has(r.bucket));

  // KPIs
  const totalCur = rows.reduce((a, r) => a + Number(r.balance || 0), 0);
  const totalTax = taxRows.reduce((a, r) => a + Number(r.balance || 0), 0);
  const totalOther = otherRows.reduce((a, r) => a + Number(r.balance || 0), 0);

  document.getElementById("kpiCurLiab").innerText = fmtUSD(totalCur);
  document.getElementById("kpiTaxLiab").innerText = fmtUSD(totalTax);
  document.getElementById("kpiOtherLiab").innerText = fmtUSD(totalOther);

  // ---- Tax table ----
  const th = document.getElementById("liabHeader");
  const tb = document.getElementById("liabBody");
  th.innerHTML = `
    <tr>
      <th>Liability</th>
      <th>Balance (proxy)</th>
      <th>Last activity</th>
      <th>Estimated due</th>
      <th>Days</th>
      <th>Accounts</th>
    </tr>`;
  tb.innerHTML = taxRows.map(r => `
    <tr>
      <td>${r.label}</td>
      <td>${XeroTables.formatCurrency(r.balance)}</td>
      <td>${r.last_activity ? r.last_activity.toLocaleDateString() : "—"}</td>
      <td>${r.due_date ? r.due_date.toLocaleDateString() : "—"}</td>
      <td>${r.due_in_days === null ? "—" : r.due_in_days}</td>
      <td>${(r.accounts || []).join("<br>")}</td>
    </tr>
  `).join("");

  // ---- Other table (no due date) ----
  const oth = document.getElementById("liabOtherHeader");
  const otb = document.getElementById("liabOtherBody");
  oth.innerHTML = `
    <tr>
      <th>Liability</th>
      <th>Balance (proxy)</th>
      <th>Last activity</th>
      <th>Accounts</th>
    </tr>`;
  otb.innerHTML = otherRows.map(r => `
    <tr>
      <td>${r.label}</td>
      <td>${XeroTables.formatCurrency(r.balance)}</td>
      <td>${r.last_activity ? r.last_activity.toLocaleDateString() : "—"}</td>
      <td>${(r.accounts || []).join("<br>")}</td>
    </tr>
  `).join("");
}

async function showLiabilities() {
  hideAllViews();
  setLoading("Building liabilities view...");

  try {
    const journals = await getJournals();
    JOURNAL_LINES = flattenJournalLines(journals);

    const rows = computeLiabilityDueEstimates(JOURNAL_LINES);
    setRawData({ journal_lines_count: JOURNAL_LINES.length, liabilities: rows });

    stopLoading();
    document.getElementById("liabilitiesContainer").style.display = "block";
    renderLiabilitiesTables(rows);
  } catch (e) {
    stopLoading();
    showError(e.message);
  }
}

window.showLiabilities = showLiabilities;

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
  document.getElementById("kpiAR").innerText = "—";
  document.getElementById("kpiAP").innerText = "—";

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
function renderTransactionTable(lines) {
  const cols = [
    { label: "Date", render: r => XeroTables.formatDate(r.date) },
    { label: "Journal #", render: r => r.journalNumber },
    { label: "Account", render: r => `${r.accountCode} ${r.accountName}`.trim() },
    { label: "Type", render: r => r.accountType },
    { label: "Description", render: r => r.description },
    { label: "Net", render: r => XeroTables.formatCurrency(r.net) }
  ];

  const max = 600; // keep UI fast
  const slice = lines.slice(0, max);

  XeroTables.renderTable(cols, slice);

  const txCount = document.getElementById("txCount");
  if (txCount) txCount.textContent = `Showing ${slice.length.toLocaleString()} of ${lines.length.toLocaleString()} lines`;
}

function applyTransactionFilters() {
  if (!JOURNAL_LINES) return;

  const q = (document.getElementById("filterAccount").value || "").toLowerCase();
  const from = document.getElementById("filterFrom").value;
  const to = document.getElementById("filterTo").value;

  const fromDate = from ? new Date(from) : null;
  const toDate = to ? new Date(to) : null;

  const filtered = JOURNAL_LINES.filter(r => {
    const acc = `${r.accountCode} ${r.accountName}`.toLowerCase();
    if (q && !acc.includes(q)) return false;

    const d = XeroTables.parseXeroDate(r.date);
    if (fromDate && d < fromDate) return false;
    if (toDate && d > toDate) return false;

    return true;
  });

  renderTransactionTable(filtered);
}

window.applyTransactionFilters = applyTransactionFilters;

// ---------- Navigation ----------
async function showDashboard() {
  hideAllViews();
  setLoading("Building dashboard from journal lines...");

  try {
    const journals = await getJournals();
    JOURNAL_LINES = flattenJournalLines(journals);

    const model = buildDashboardModel(JOURNAL_LINES);
    const liabRows = computeLiabilityDueEstimates(JOURNAL_LINES);
    const health = computeHealthFromModel(model, liabRows);

    setRawData({
      journals_count: journals.length,
      journal_lines_count: JOURNAL_LINES.length,
      model,
      liabilities: liabRows,
      health
    });

    stopLoading();
    document.getElementById("dashboardContainer").style.display = "block";

    renderDashboard(model);      // renders charts + KPIs
    renderHealthStrip(health);   // renders strip (depends on DOM)

  } catch (e) {
    stopLoading();
    showError(e.message);
  }
}


async function showTransactions() {
  hideAllViews();
  setLoading("Loading journal lines...");
  try {
    const journals = await getJournals();
    JOURNAL_LINES = flattenJournalLines(journals);

    // ✅ ADD THIS LINE
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
    renderTransactionTable(JOURNAL_LINES);
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
    // restore dashboard if visible else transactions
    const dash = document.getElementById("dashboardContainer");
    const tx = document.getElementById("transactionsContainer");
    if (dash && dash.style.display === "block") dash.style.display = "block";
    else if (tx) tx.style.display = "block";
    btn.innerText = "Show Raw JSON";
    showingRaw = false;
  } else {
    // hide views, show raw
    const dash = document.getElementById("dashboardContainer");
    const tx = document.getElementById("transactionsContainer");
    if (dash) dash.style.display = "none";
    if (tx) tx.style.display = "none";
    raw.style.display = "block";
    raw.innerText = JSON.stringify(currentData, null, 2);
    btn.innerText = "Show UI";
    showingRaw = true;
  }
}
window.showRawJson = showRawJson;

// ---------- Auth + health ----------
function authorize() {
  const w = XeroAPI.open_auth_popup();
  const timer = setInterval(() => {
    if (w.closed) {
      clearInterval(timer);
      setTimeout(checkHealth, 800);
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
window.checkHealth = checkHealth;

// Auto-open dashboard on page load
document.addEventListener("DOMContentLoaded", () => {
  showDashboard();
});