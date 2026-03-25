function buildCashTimeline(data, grossBalance) {
  const labels = data?.charts?.sales_fy?.labels || data?.charts?.expenses_fy?.labels || [];
  const revenueProjected = data?.charts?.sales_fy?.projected_monthly || [];
  const expenseProjected = data?.charts?.expenses_fy?.projected_monthly || [];
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
    const rev = Number(revenueProjected[i]);
    const exp = Number(expenseProjected[i]);
    const hasBudget = Number.isFinite(rev) && Number.isFinite(exp);
    const budgetNet = hasBudget ? rev - exp : null;
    const liabsThisMonth = liabByMonth[month] || [];
    const liabTotal = liabsThisMonth.reduce((s, l) => s + l.amount, 0);

    runningBalance -= liabTotal;
    if (budgetNet !== null) runningBalance += budgetNet;

    rows.push({ month, liabsThisMonth, liabTotal, budgetNet, runningBalance, isNegative: runningBalance < 0 });
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

  let headline;
  if (hasNegative) {
    headline = `Cash shortfall projected in <strong>${fmtTimelineMonth(rows[firstNegativeIdx].month)}</strong>`;
  } else {
    const tightLabel = minRow
      ? ` · lowest point <strong>${fmtCurrency(minRow.runningBalance)}</strong> in ${fmtTimelineMonth(minRow.month)}`
      : "";
    headline = `<span style="color:#2f6e5f;font-weight:800">Cash positive through FY end</span><span style="color:#6b7280;font-weight:500">${tightLabel}</span>`;
  }

  const tableRows = rows.map((row, idx) => {
    const isFirst = idx === firstNegativeIdx;
    const rowClass = isFirst ? "ct-first-negative" : (row.isNegative ? "ct-negative" : "");
    const liabCell = row.liabTotal > 0
      ? `<span style="color:#ec4899">-${fmtCurrency(row.liabTotal)}</span>`
      : `<span style="color:#cbd5e1">—</span>`;
    const budgetCell = row.budgetNet !== null
      ? `<span style="color:${row.budgetNet >= 0 ? "#3b82f6" : "#ec4899"}">${row.budgetNet >= 0 ? "+" : ""}${fmtCurrency(row.budgetNet)}</span>`
      : `<span style="color:#cbd5e1">—</span>`;
    const liabTip = row.liabsThisMonth.map(l => `${l.name}: ${fmtCurrency(l.amount)}`).join(" · ");
    return `<tr class="${rowClass}">
      <td>${fmtTimelineMonth(row.month)}</td>
      <td title="${liabTip}">${liabCell}</td>
      <td>${budgetCell}</td>
      <td>${fmtCurrency(row.runningBalance)}</td>
    </tr>`;
  }).join("");

  container.style.display = "";
  container.innerHTML = `
    <div style="display:flex;align-items:baseline;justify-content:space-between;margin-bottom:14px;flex-wrap:wrap;gap:6px;">
      <h3 class="rebuilt-panel-title" style="margin:0">Cash timeline</h3>
      <span style="font-size:13px;color:#374151">${headline}</span>
    </div>
    <div style="overflow-x:auto">
      <table class="cash-timeline-table">
        <thead><tr><th>Month</th><th>Liabilities due</th><th>Budget net</th><th>Running balance</th></tr></thead>
        <tbody>${tableRows}</tbody>
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