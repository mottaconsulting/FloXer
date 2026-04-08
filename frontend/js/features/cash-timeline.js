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

function buildCashTimeline(data, grossBalance) {
  const salesChart = data?.charts?.sales_fy || {};
  const expensesChart = data?.charts?.expenses_fy || {};
  const labels = salesChart.labels || expensesChart.labels || [];
  const revenueProjected = salesChart.projected_monthly || [];
  const expenseProjected = expensesChart.projected_monthly || [];
  const asOfMonth = data?.meta?.as_of_month;
  const cutoffIdx = asOfMonth ? labels.indexOf(asOfMonth) : -1;
  const liabilitySchedule = data?.kpis?.liability_schedule || [];

  if (!labels.length || cutoffIdx < 0) return null;

  // Group liabilities by due month
  const liabByMonth = {};
  for (const liab of liabilitySchedule) {
    if (!liabByMonth[liab.month]) liabByMonth[liab.month] = [];
    liabByMonth[liab.month].push(liab);
  }

  let runningBalance = Number(grossBalance);
  const rows = [];

  for (let i = cutoffIdx + 1; i < labels.length; i++) {
    const month = labels[i];
    // These are future months — use budget (projected) directly.
    // Actuals for future months are not reliable (Xero demo has phantom values).
    const rev = finiteNumberOrNaN(revenueProjected[i]);
    const exp = finiteNumberOrNaN(expenseProjected[i]);
    const hasBudget = Number.isFinite(rev) && Number.isFinite(exp);
    const budgetNet = hasBudget ? rev - exp : null;
    const budgetRev = hasBudget ? rev : null;
    const budgetExp = hasBudget ? exp : null;
    const liabsThisMonth = liabByMonth[month] || [];
    const liabTotal = liabsThisMonth.reduce((s, l) => s + l.amount, 0);

    runningBalance -= liabTotal;
    if (budgetNet !== null) runningBalance += budgetNet;

    rows.push({ month, liabsThisMonth, liabTotal, budgetNet, budgetRev, budgetExp, runningBalance, isNegative: runningBalance < 0 });
  }

  const firstNegativeIdx = rows.findIndex(r => r.isNegative);
  const minRow = rows.reduce((a, b) => b.runningBalance < a.runningBalance ? b : a, rows[0]);
  return { rows, firstNegativeIdx, minRow };
}

function fmtTimelineMonth(yyyymm) {
  const [y, m] = yyyymm.split("-");
  return new Date(Number(y), Number(m) - 1, 1).toLocaleDateString("en-AU", { month: "short", year: "numeric" });
}

function renderCashTimeline(data, grossBalance, isPastFy) {
  const container = document.getElementById("dashboardCashTimeline");
  if (!container || isPastFy) { if (container) container.style.display = "none"; return; }

  const timeline = buildCashTimeline(data, grossBalance);
  if (!timeline || !timeline.rows.length) { container.style.display = "none"; return; }

  const { rows, firstNegativeIdx, minRow } = timeline;
  const hasNegative = firstNegativeIdx >= 0;
  const allNoBudget = rows.every(r => r.budgetNet === null);
  if (allNoBudget) { container.style.display = "none"; return; }

  const headlineHtml = hasNegative
    ? `<span class="ct-headline ct-headline-neg">Shortfall projected in <strong>${fmtTimelineMonth(rows[firstNegativeIdx].month)}</strong></span>`
    : `<span class="ct-headline ct-headline-pos">Cash positive through FY end${minRow ? ` · lowest <strong>${fmtCurrency(minRow.runningBalance)}</strong> in ${fmtTimelineMonth(minRow.month)}` : ""}</span>`;

  // Starting balance tbody
  const startBalClass = Number(grossBalance) >= 0 ? "ct-bal-pos" : "ct-bal-neg";
  let tbodyHtml = `<tbody>
    <tr class="ct-start-row">
      <td>Current balance</td>
      <td class="ct-bal ${startBalClass}">${fmtCurrency(grossBalance)}</td>
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
      ? `<tr class="ct-section-label ct-section-budget"><td colspan="2">Forecast</td></tr>
         <tr class="ct-detail-row ct-budget-row">
           <td>Revenue</td>
           <td class="ct-pos-amt">+${fmtCurrency(row.budgetRev)}</td>
         </tr>
         <tr class="ct-detail-row ct-budget-row">
           <td>Expenses</td>
           <td class="ct-neg-amt">-${fmtCurrency(row.budgetExp)}</td>
         </tr>
         <tr class="ct-detail-row ct-budget-row ct-budget-net-row">
           <td>Net</td>
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

  // ── Obligations section ──
  const taxObligations  = data?.kpis?.liability_schedule || [];
  const accountsPayable = data?.kpis?.accounts_payable   || [];
  const upcomingAccruals = data?.kpis?.upcoming_accruals  || [];

  const totalTax      = taxObligations.reduce((s, l)  => s + Number(l.amount || 0), 0);
  const totalPayable  = accountsPayable.reduce((s, l) => s + Number(l.amount || 0), 0);
  const totalAccruals = upcomingAccruals.reduce((s, l) => s + Number(l.amount || 0), 0);
  const grandTotal    = totalTax + totalPayable + totalAccruals;

  function liabRow(l, indicative = false) {
    const monthLabel = l.due_month ? fmtTimelineMonth(l.due_month) : (l.month ? fmtTimelineMonth(l.month) : "—");
    return `<tr class="ct-liab-view-row${indicative ? " ct-liab-indicative" : ""}">
      <td class="ct-liab-view-name">${l.name}${indicative ? ' <span class="ct-indicative-tag">est.</span>' : ""}</td>
      <td class="ct-liab-view-month">${monthLabel}</td>
      <td class="ct-liab-view-amt ${indicative ? "ct-neg-amt-muted" : "ct-neg-amt"}">-${fmtCurrency(l.amount)}</td>
    </tr>`;
  }

  function obligationSection(title, rows, total, indicative = false) {
    if (!rows.length) return "";
    return `
      <div class="ct-oblig-section">
        <div class="ct-oblig-section-head">
          <span class="ct-oblig-section-title">${title}</span>
          <span class="${indicative ? "ct-neg-amt-muted" : "ct-neg-amt"}" style="font-size:13px;font-weight:700;">-${fmtCurrency(total)}</span>
        </div>
        <table class="ct-obligations-table">
          <thead><tr><th>Name</th><th>Due</th><th>Amount</th></tr></thead>
          <tbody>${rows.map(l => liabRow(l, indicative)).join("")}</tbody>
        </table>
      </div>`;
  }

  const obligationsHtml = grandTotal < 0.01 ? "" : `
    <div class="ct-obligations-section">
      <div class="ct-obligations-header">
        <span class="ct-obligations-title">Committed obligations</span>
        <span class="ct-neg-amt" style="font-size:15px;font-weight:800;">-${fmtCurrency(grandTotal)} total</span>
      </div>
      ${obligationSection("Tax obligations", taxObligations, totalTax)}
      ${obligationSection("Accounts payable", accountsPayable, totalPayable)}
      ${obligationSection("Upcoming accruals", upcomingAccruals, totalAccruals, true)}
    </div>`;

  const summaryItems = [
    { label: "Current balance", value: fmtCurrency(grossBalance), cls: Number(grossBalance) >= 0 ? "ct-bal-pos" : "ct-bal-neg" },
    { label: "Lowest point", value: minRow ? fmtCurrency(minRow.runningBalance) : "--", cls: minRow && minRow.runningBalance < 0 ? "ct-bal-neg" : "ct-bal-pos" },
    { label: hasNegative ? "First shortfall" : "FY end balance", value: hasNegative ? fmtTimelineMonth(rows[firstNegativeIdx].month) : fmtCurrency(rows[rows.length - 1].runningBalance), cls: hasNegative ? "ct-bal-neg" : "ct-bal-pos" },
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
    ${obligationsHtml}
    <div class="ct-headline-row">${headlineHtml}</div>
    <div style="overflow-x:auto">
      <table class="cash-timeline-table">
        ${tbodyHtml}
      </table>
    </div>`;
}

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
    renderCashTimeline(cachedData, balanceKpi.balance, isPastFy);
    return;
  }

  if (typeof setLoading === "function") setLoading("Loading cash timeline...");
  try {
    const data = await fetchOverview(todayOverride, 7, null, null, {});
    if (typeof stopLoading === "function") stopLoading();
    const isPastFy = typeof isPastFinancialYearSelection === "function" ? isPastFinancialYearSelection(data) : false;
    const balanceKpi = typeof computeBalanceKpi === "function" ? computeBalanceKpi(data) : { balance: data?.kpis?.cash_balance_live ?? 0 };
    renderCashTimeline(data, balanceKpi.balance, isPastFy);
  } catch (e) {
    if (typeof stopLoading === "function") stopLoading();
    if (typeof showError === "function") showError(e.message);
  }
}

window.showCashTimeline = showCashTimeline;