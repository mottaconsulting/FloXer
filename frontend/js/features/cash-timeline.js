function _bestOf(actual, budget) {
  // Returns the higher of actual vs budget when both are available.
  // For expenses: higher = more conservative (worse case).
  // For revenue: higher = more accurate (actual beat budget).
  // Falls back to whichever value is finite if only one is available.
  const a = finiteNumberOrNaN(actual);
  const b = finiteNumberOrNaN(budget);
  if (Number.isFinite(a) && Number.isFinite(b)) return Math.max(a, b);
  if (Number.isFinite(a)) return a;
  if (Number.isFinite(b)) return b;
  return NaN;
}

function buildCashTimeline(data, startingBalance) {
  const explicitRows = data?.projection?.forecast_operating || [];
  if (!explicitRows.length) return null;

  const rows = explicitRows.map(row => ({
    month: row.month,
    liabsThisMonth: [
      ...(data?.obligations?.future_known || []).filter(item => item.month === row.month),
      ...(data?.obligations?.future_forecast || []).filter(item => item.month === row.month),
    ],
    liabTotal: Number(row.obligations_total || 0),
    budgetNet: row.operating_net,
    budgetRev: row.operating_revenue,
    budgetExp: row.operating_expenses,
    runningBalance: Number(row.closing_cash || 0),
    isNegative: Boolean(row.is_negative),
  }));
  const firstNegativeIdx = rows.findIndex(r => r.isNegative);
  const minRow = rows.length ? rows.reduce((a, b) => b.runningBalance < a.runningBalance ? b : a, rows[0]) : null;
  return { rows, firstNegativeIdx, minRow };
}

function fmtTimelineMonth(yyyymm) {
  const [y, m] = yyyymm.split("-");
  return new Date(Number(y), Number(m) - 1, 1).toLocaleDateString("en-AU", { month: "short", year: "numeric" });
}

function renderCashTimeline(data, startingBalance, isPastFy) {
  const container = document.getElementById("dashboardCashTimeline");
  if (!container || isPastFy) { if (container) container.style.display = "none"; return; }

  const grossCashToday = Number(data?.kpis?.gross_cash_today ?? startingBalance);
  const committedCashToday = Number(data?.kpis?.committed_cash_today ?? 0);
  const freeCashToday = Number.isFinite(Number(data?.kpis?.free_cash_today))
    ? Number(data.kpis.free_cash_today)
    : Number(startingBalance);

  const timeline = buildCashTimeline(data, freeCashToday);
  if (!timeline || !timeline.rows.length) { container.style.display = "none"; return; }

  const { rows, firstNegativeIdx, minRow } = timeline;
  const hasNegative = firstNegativeIdx >= 0;
  const allNoBudget = rows.every(r => r.budgetNet === null);
  if (allNoBudget) { container.style.display = "none"; return; }

  const headlineHtml = hasNegative
    ? `<span class="ct-headline ct-headline-neg">Shortfall projected in <strong>${fmtTimelineMonth(rows[firstNegativeIdx].month)}</strong></span>`
    : `<span class="ct-headline ct-headline-pos">Projected cash positive through FY end${minRow ? ` · lowest <strong>${fmtCurrency(minRow.runningBalance)}</strong> in ${fmtTimelineMonth(minRow.month)}` : ""}</span>`;

  // Starting balance tbody
  const startBalClass = Number(grossCashToday) >= 0 ? "ct-bal-pos" : "ct-bal-neg";
  const freeCashClass = Number(freeCashToday) >= 0 ? "ct-bal-pos" : "ct-bal-neg";
  let tbodyHtml = `<tbody>
    <tr class="ct-start-row">
      <td>Bank balance</td>
      <td class="ct-bal ${startBalClass}">${fmtCurrency(grossCashToday)}</td>
    </tr>
    <tr class="ct-detail-row ct-liab-row">
      <td>Committed this month</td>
      <td class="ct-neg-amt">-${fmtCurrency(committedCashToday)}</td>
    </tr>
    <tr class="ct-month-row">
      <td>Free cash starting point</td>
      <td class="ct-bal ${freeCashClass}">${fmtCurrency(freeCashToday)}</td>
    </tr>
  </tbody>`;

  // One tbody per month group
  rows.forEach((row, idx) => {
    const isFirstNeg = idx === firstNegativeIdx;
    const groupClass = isFirstNeg ? "ct-group ct-group-first-neg" : (row.isNegative ? "ct-group ct-group-neg" : "ct-group");
    const balClass = row.runningBalance >= 0 ? "ct-bal-pos" : "ct-bal-neg";

    // Liability sub-rows with section label
    const hasLiabs = row.liabsThisMonth.length > 0;
    const liabSection = hasLiabs
      ? `<tr class="ct-section-label"><td colspan="2">Obligations due</td></tr>` +
        row.liabsThisMonth.map(l =>
          `<tr class="ct-detail-row ct-liab-row">
            <td>${l.name}</td>
            <td class="ct-neg-amt">-${fmtCurrency(l.amount)}</td>
          </tr>`
        ).join("")
      : "";

    // Budget net sub-row with section label
    const budgetRow = row.budgetNet !== null
      ? `<tr class="ct-section-label ct-section-budget"><td colspan="2">Operating Forecast</td></tr>
         <tr class="ct-detail-row ct-budget-row">
           <td>Revenue</td>
           <td class="ct-pos-amt">+${fmtCurrency(row.budgetRev)}</td>
         </tr>
         <tr class="ct-detail-row ct-budget-row">
           <td>Expenses</td>
           <td class="ct-neg-amt">-${fmtCurrency(row.budgetExp)}</td>
         </tr>
         <tr class="ct-detail-row ct-budget-row ct-budget-net-row">
           <td>Operating net</td>
           <td class="${row.budgetNet >= 0 ? "ct-pos-amt" : "ct-neg-amt"}">${row.budgetNet >= 0 ? "+" : ""}${fmtCurrency(row.budgetNet)}</td>
         </tr>`
      : "";

    tbodyHtml += `<tbody class="${groupClass}">
      <tr class="ct-month-row">
        <td>${fmtTimelineMonth(row.month)}${isFirstNeg ? ' <span class="ct-badge-neg">Shortfall</span>' : ""}</td>
        <td class="ct-bal ${balClass}">${fmtCurrency(row.runningBalance)}</td>
      </tr>
      ${liabSection}${budgetRow}
      <tr class="ct-group-sep"><td colspan="2"></td></tr>
    </tbody>`;
  });

  // ── Obligations data ──
  const committedThisMonth = data?.obligations?.committed_this_month || [];
  const futureKnown = data?.obligations?.future_known || [];
  const futureForecast = data?.obligations?.future_forecast || [];
  const taxObligations   = [...futureKnown, ...futureForecast].filter(l => String(l.type || "").toLowerCase() !== "payable");
  const accountsPayable  = [...futureKnown, ...futureForecast].filter(l => String(l.type || "").toLowerCase() === "payable");
  const upcomingAccruals = futureForecast.filter(l => Boolean(l.indicative));
  const totalCommittedThisMonth = committedThisMonth.reduce((s, l) => s + Number(l.amount || 0), 0);
  const totalTax      = taxObligations.filter(l => !Boolean(l.indicative)).reduce((s, l)  => s + Number(l.amount || 0), 0);
  const totalPayable  = accountsPayable.reduce((s, l) => s + Number(l.amount || 0), 0);
  const totalAccruals = upcomingAccruals.reduce((s, l) => s + Number(l.amount || 0), 0);
  const grandTotal    = totalCommittedThisMonth + totalTax + totalPayable + totalAccruals;

  // ── Helpers ──
  function liabTableRow(l, indicative = false) {
    const monthLabel = l.due_month ? fmtTimelineMonth(l.due_month) : (l.month ? fmtTimelineMonth(l.month) : "—");
    const isProjected = l.projected === true;
    const tag = indicative
      ? ' <span class="ct-indicative-tag">est.</span>'
      : isProjected ? ' <span class="ct-indicative-tag">projected</span>' : "";
    return `<tr class="ct-liab-view-row${indicative || isProjected ? " ct-liab-indicative" : ""}">
      <td class="ct-liab-view-name">${l.name}${tag}</td>
      <td class="ct-liab-view-month">${monthLabel}</td>
      <td class="ct-liab-view-amt ${indicative || isProjected ? "ct-neg-amt-muted" : "ct-neg-amt"}">-${fmtCurrency(l.amount)}</td>
    </tr>`;
  }

  function apRows() {
    if (!accountsPayable.length) return "";
    // Group by month (all already current month+)
    const byMonth = {};
    accountsPayable.forEach(l => {
      const m = l.due_month || l.month || "unknown";
      if (!byMonth[m]) byMonth[m] = [];
      byMonth[m].push(l);
    });
    let html = "";
    Object.keys(byMonth).sort().forEach(m => {
      const grp = byMonth[m];
      const total = grp.reduce((s, l) => s + Number(l.amount || 0), 0);
      html += `<tr class="ct-ap-group-row"><td colspan="2">${fmtTimelineMonth(m)} (${grp.length})</td><td class="ct-neg-amt">-${fmtCurrency(total)}</td></tr>`;
      html += grp.map(l => liabTableRow(l)).join("");
    });
    return html;
  }

  function accordion(id, title, total, bodyHtml, indicative = false) {
    if (!total && !bodyHtml) return "";
    const amtCls = indicative ? "ct-neg-amt-muted" : "ct-neg-amt";
    const estBadge = indicative ? '<span class="ct-indicative-tag" style="margin-left:6px;">estimated</span>' : "";
    return `
      <div class="ct-accordion" id="ct-acc-${id}">
        <button class="ct-accordion-trigger" onclick="ctAccToggle('ct-acc-${id}')">
          <span class="ct-acc-title">${title}${estBadge}</span>
          <span class="ct-acc-right">
            <span class="${amtCls}">-${fmtCurrency(total)}</span>
            <svg class="ct-chevron" viewBox="0 0 20 20" fill="currentColor"><path fill-rule="evenodd" d="M5.23 7.21a.75.75 0 011.06.02L10 11.168l3.71-3.938a.75.75 0 111.08 1.04l-4.25 4.5a.75.75 0 01-1.08 0l-4.25-4.5a.75.75 0 01.02-1.06z" clip-rule="evenodd"/></svg>
          </span>
        </button>
        <div class="ct-accordion-content" style="display:none;">
          <table class="ct-obligations-table">
            <thead><tr><th>Name</th><th>Due</th><th>Amount</th></tr></thead>
            <tbody>${bodyHtml}</tbody>
          </table>
        </div>
      </div>`;
  }

  // ── Summary bar ──
  const summaryItems = [
    { label: "Bank balance", value: fmtCurrency(grossCashToday), cls: Number(grossCashToday) >= 0 ? "ct-bal-pos" : "ct-bal-neg" },
    { label: "Committed this month", value: totalCommittedThisMonth > 0 ? `-${fmtCurrency(totalCommittedThisMonth)}` : "—", cls: totalCommittedThisMonth > 0 ? "ct-bal-neg" : "ct-bal-pos" },
    { label: "Free cash", value: fmtCurrency(freeCashToday), cls: Number(freeCashToday) >= 0 ? "ct-bal-pos" : "ct-bal-neg" },
    { label: "Lowest point", value: minRow ? fmtCurrency(minRow.runningBalance) : "--", cls: minRow && minRow.runningBalance < 0 ? "ct-bal-neg" : "ct-bal-pos" },
    { label: hasNegative ? "First shortfall" : "FY end cash", value: hasNegative ? fmtTimelineMonth(rows[firstNegativeIdx].month) : fmtCurrency(rows[rows.length - 1].runningBalance), cls: hasNegative ? "ct-bal-neg" : "ct-bal-pos" },
  ];

  container.style.display = "";
  container.innerHTML = `
    <div class="ct-summary-bar">
      ${summaryItems.map(s => `
        <div class="ct-summary-item">
          <span class="ct-summary-label">${s.label}</span>
          <span class="ct-summary-value ${s.cls}">${s.value}</span>
        </div>`).join("")}
    </div>

    <div class="ct-page-card">
      <div class="ct-page-card-header">
        <span class="ct-page-card-title">Cash Projection</span>
        ${headlineHtml}
      </div>
      <div style="overflow-x:auto">
        <table class="cash-timeline-table">${tbodyHtml}</table>
      </div>
    </div>

    ${grandTotal > 0 ? `
    <div class="ct-page-card ct-page-card-obligations">
      <div class="ct-page-card-header">
        <span class="ct-page-card-title">Committed Obligations</span>
        <span class="ct-neg-amt" style="font-size:16px;font-weight:800;">-${fmtCurrency(grandTotal)}</span>
      </div>
      ${accordion("now", "Committed this month", totalCommittedThisMonth, committedThisMonth.map(l => liabTableRow(l)).join(""))}
      ${accordion("tax", "Tax obligations", totalTax, taxObligations.filter(l => !Boolean(l.indicative)).map(l => liabTableRow(l)).join(""))}
      ${accordion("ap", "Accounts payable", totalPayable, apRows())}
      ${accordion("accruals", "Upcoming accruals", totalAccruals, upcomingAccruals.map(l => liabTableRow(l, true)).join(""), true)}
    </div>` : ""}`;
}

function ctAccToggle(id) {
  const acc = document.getElementById(id);
  if (!acc) return;
  const content = acc.querySelector(".ct-accordion-content");
  const chevron = acc.querySelector(".ct-chevron");
  const open = content.style.display !== "none";
  content.style.display = open ? "none" : "";
  chevron.style.transform = open ? "" : "rotate(180deg)";
}
window.ctAccToggle = ctAccToggle;

async function showCashTimeline() {
  if (typeof hideAllViews === "function") hideAllViews();
  if (typeof setActiveSidebarNav === "function") setActiveSidebarNav("cash-timeline");

  const container = document.getElementById("cashTimelineContainer");
  if (container) container.style.display = "block";

  const todayOverride = typeof selectedOverviewToday === "function" ? selectedOverviewToday() : null;
  const qs = typeof buildOverviewQueryString === "function" ? buildOverviewQueryString(todayOverride, 7, null, null) : "";
  const cachedEntry = typeof getCachedOverviewEntry === "function" ? getCachedOverviewEntry(qs) : null;
  const cachedData = cachedEntry?.data || null;

  if (cachedData) {
    const isPastFy = typeof isPastFinancialYearSelection === "function" ? isPastFinancialYearSelection(cachedData) : false;
    const balanceKpi = typeof computeBalanceKpi === "function" ? computeBalanceKpi(cachedData) : { balance: cachedData?.kpis?.cash_balance_live ?? 0 };
    renderCashTimeline(cachedData, balanceKpi.freeCash ?? balanceKpi.balance, isPastFy);
    return;
  }

  if (typeof setLoading === "function") setLoading("Loading cash timeline...");
  try {
    const data = await fetchOverview(todayOverride, 7, null, null, {});
    if (typeof stopLoading === "function") stopLoading();
    const isPastFy = typeof isPastFinancialYearSelection === "function" ? isPastFinancialYearSelection(data) : false;
    const balanceKpi = typeof computeBalanceKpi === "function" ? computeBalanceKpi(data) : { balance: data?.kpis?.cash_balance_live ?? 0 };
    renderCashTimeline(data, balanceKpi.freeCash ?? balanceKpi.balance, isPastFy);
  } catch (e) {
    if (typeof stopLoading === "function") stopLoading();
    if (typeof showError === "function") showError(e.message);
  }
}

window.showCashTimeline = showCashTimeline;
