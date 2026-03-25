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
  return { rows, firstNegativeIdx };
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

  const { rows, firstNegativeIdx } = timeline;
  const hasNegative = firstNegativeIdx >= 0;
  const allNoBudget = rows.every(r => r.budgetNet === null);
  if (allNoBudget) { container.style.display = "none"; return; }

  const headline = hasNegative
    ? `Cash shortfall projected in <strong>${fmtTimelineMonth(rows[firstNegativeIdx].month)}</strong>`
    : `<span style="color:#2f6e5f;font-weight:800">You are cash positive through FY end</span>`;

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

function selectedCompanyName() {
  const selected = document.getElementById("orgSelect")?.selectedOptions?.[0]?.textContent?.trim();
  if (selected && !/no organizations|org unavailable|organization/i.test(selected)) return selected;
  return "Company";
}

async function renderDashboardRecentTransactions() {
  const body = document.getElementById("dashboardRecentTransactionsBody");
  if (!body) return;
  try {
    const journals = JOURNAL_LINES || flattenJournalLines(await getJournals());
    JOURNAL_LINES = journals;
    const recent = journals.slice(0, 6);
    if (!recent.length) {
      body.innerHTML = `<tr><td colspan="4" class="rebuilt-empty">No recent journal lines found.</td></tr>`;
      return;
    }
    body.innerHTML = recent.map(row => {
      const amount = Number(row.net || 0);
      return `
        <tr>
          <td>${escapeHtmlText(XeroTables.formatDate(row.date))}</td>
          <td>${escapeHtmlText(row.accountName || "—")}</td>
          <td>${escapeHtmlText(row.description || "—")}</td>
          <td class="tx-money ${amount < 0 ? "money-in" : amount > 0 ? "money-out" : ""}">${escapeHtmlText(XeroTables.formatCurrency(amount))}</td>
        </tr>
      `;
    }).join("");
  } catch (_) {
    body.innerHTML = `<tr><td colspan="4" class="rebuilt-empty">Unable to load recent transactions.</td></tr>`;
  }
}

function bindBalanceAdjustEvents() {
  if (BALANCE_ADJUST_EVENTS_BOUND) return;
  const toggleBtn = document.getElementById("dashboardBalanceAdjustToggle");
  if (!toggleBtn) return;
  toggleBtn.addEventListener("click", () => {
    const data = window.XeroUI?.getRawData?.();
    const isPastFy = isPastFinancialYearSelection(data || {});
    if (isPastFy) return;
    const balanceKpi = computeBalanceKpi(data || {});
    const defaultValue = Number.isFinite(balanceKpi.balance) ? String(Math.round(balanceKpi.balance)) : "";
    const raw = window.prompt("Edit Current Balance. Leave blank to reset to live Xero value.", defaultValue);
    if (raw === null) return;
    const next = String(raw).trim();
    if (!next) {
      setBalanceOverrideValue(data || {}, null);
    } else {
      const parsed = parseCurrencyInput(next);
      if (!Number.isFinite(parsed)) {
        showError("Enter a valid number for Current Balance.");
        return;
      }
      setBalanceOverrideValue(data || {}, parsed);
    }
    if (data) renderOverview(data);
  });
  BALANCE_ADJUST_EVENTS_BOUND = true;
}

let BURN_NOTE_EVENTS_BOUND = false;
function bindBurnNotePopover() {
  if (BURN_NOTE_EVENTS_BOUND) return;
  const note = document.getElementById("dashboardBurnNote");
  if (!note) return;

  // Create popover element once
  const pop = document.createElement("div");
  pop.id = "burnNotePopover";
  pop.style.cssText = [
    "position:fixed", "z-index:9999", "background:#fff",
    "border:1px solid #dbe2ea", "border-radius:10px",
    "padding:14px 16px", "box-shadow:0 8px 24px rgba(15,23,42,0.12)",
    "font-size:13px", "font-family:Inter,sans-serif", "min-width:200px",
    "display:none", "line-height:1.7"
  ].join(";");
  document.body.appendChild(pop);

  note.style.cursor = "pointer";
  note.addEventListener("click", (e) => {
    e.stopPropagation();
    if (pop.style.display !== "none") { pop.style.display = "none"; return; }
    const rev        = Number(note.dataset.fyRevenue);
    const exp        = Number(note.dataset.fyExpense);
    const net        = Number(note.dataset.fyNet);
    const monthsLeft = Number(note.dataset.monthsLeft) || 0;
    const committed  = Number(note.dataset.committed) || 0;
    const freeBal    = Number(note.dataset.freeBalance);
    const fmtNum     = v => Number.isFinite(v) ? fmtCurrency(Math.abs(v)) : "--";
    const netSign    = net >= 0 ? "+" : "-";
    const netCol     = net >= 0 ? "#3b82f6" : "#ec4899";
    const sentence   = net >= 0
      ? `Budget projects a surplus over the next ${monthsLeft} month${monthsLeft !== 1 ? "s" : ""}.`
      : `Budget projects a shortfall over the next ${monthsLeft} month${monthsLeft !== 1 ? "s" : ""}.`;
    const committedSection = committed > 0 ? `
      <div style="margin-top:12px;padding-top:10px;border-top:1px solid #dbe2ea;">
        <div style="font-weight:700;color:#0d1b4b;margin-bottom:4px">Current cash position</div>
        <div style="display:grid;grid-template-columns:1fr auto;gap:2px 16px;color:#374151">
          <span>Free cash</span><span style="color:#3b82f6;font-weight:700">${fmtNum(freeBal)}</span>
          <span>Committed</span><span style="color:#ec4899;font-weight:700">-${fmtNum(committed)}</span>
        </div>
      </div>` : "";
    pop.innerHTML = `
      <div style="font-weight:700;color:#0d1b4b;margin-bottom:6px">Remaining FY budget</div>
      <div style="color:#6b7280;font-size:12px;margin-bottom:10px">${sentence}</div>
      <div style="display:grid;grid-template-columns:1fr auto;gap:2px 16px;color:#374151">
        <span>Revenue</span><span style="color:#3b82f6;font-weight:700">+${fmtNum(rev)}</span>
        <span>Expenses</span><span style="color:#ec4899;font-weight:700">-${fmtNum(exp)}</span>
        <span style="border-top:1px solid #dbe2ea;padding-top:6px;margin-top:4px;font-weight:700">Net</span>
        <span style="border-top:1px solid #dbe2ea;padding-top:6px;margin-top:4px;font-weight:800;color:${netCol}">${netSign}${fmtNum(net)}</span>
      </div>
      ${committedSection}`;
    const rect = note.getBoundingClientRect();
    pop.style.display = "block";
    const pw = pop.offsetWidth;
    let left = rect.right - pw;
    if (left < 8) left = 8;
    pop.style.top  = `${rect.bottom + 6}px`;
    pop.style.left = `${left}px`;
  });

  document.addEventListener("click", () => { pop.style.display = "none"; });
  BURN_NOTE_EVENTS_BOUND = true;
}

function renderBalanceAdjustState(balanceKpi, isPastFy) {
  const toggleBtn = document.getElementById("dashboardBalanceAdjustToggle");
  const sourceEl = document.getElementById("dashboardBalanceSource");
  if (!toggleBtn || !sourceEl) return;
  toggleBtn.style.display = isPastFy ? "none" : "inline-flex";
  sourceEl.textContent = "";
}

function renderOverview(data) {
  const kpis = data?.kpis || {};
  setAppCurrency(data?.meta?.currency);
  bindBalanceAdjustEvents();
  bindBurnNotePopover();
  populateFySelect(data);
  const yearProfitKpi = computeYearProfitKpi(data);
  const balanceKpi = computeBalanceKpi(data);
  const companyName = selectedCompanyName();
  const greeting = document.getElementById("dashboardGreeting");
  if (greeting) greeting.textContent = `Hi, ${companyName}`;
  const fyLabel = selectedFyLabelFromUiOrData(data);
  const isPastFy = isPastFinancialYearSelection(data);
  const secondKpiLabel = document.getElementById("dashboardSecondKpiLabel");
  const thirdKpiLabel = document.getElementById("dashboardThirdKpiLabel");
  if (secondKpiLabel) secondKpiLabel.textContent = isPastFy ? "Total Revenue" : "Current Balance";
  if (thirdKpiLabel) thirdKpiLabel.textContent = isPastFy ? "Total Expenses" : "Out of Cash";
  const graphFyCash = document.getElementById("graphFyLabelCashflow");
  const graphFyRevenue = document.getElementById("graphFyLabelRevenue");
  if (graphFyCash) graphFyCash.textContent = fyLabel;
  if (graphFyRevenue) graphFyRevenue.textContent = fyLabel;
  const fyEndYear = data?.meta?.fy_end ? Number(String(data.meta.fy_end).slice(0, 4)) : null;
  const profitLabel = document.getElementById("dashboardProfitLabel");
  if (profitLabel) profitLabel.textContent = Number.isFinite(fyEndYear) ? `Profit ${fyEndYear - 1}-${fyEndYear}` : "Profit";
  const profitValue = document.getElementById("dashboardProfitValue");
  if (profitValue) {
    profitValue.classList.remove("positive", "negative");
    profitValue.textContent = Number.isFinite(yearProfitKpi.yearProfit) ? fmtCurrency(yearProfitKpi.yearProfit) : "--";
    if (Number.isFinite(yearProfitKpi.yearProfit)) profitValue.classList.add(yearProfitKpi.yearProfit < 0 ? "negative" : "positive");
  }
  const profitTrend = document.getElementById("dashboardProfitTrend");
  if (profitTrend) {
    profitTrend.classList.remove("up", "down", "flat");
    if (Number.isFinite(yearProfitKpi.changePct)) {
      const direction = yearProfitKpi.changePct > 0 ? "up" : (yearProfitKpi.changePct < 0 ? "down" : "flat");
      profitTrend.textContent = `${direction === "up" ? "+" : (direction === "down" ? "-" : "=")} ${Math.round(Math.abs(yearProfitKpi.changePct))}% vs PY`;
      profitTrend.classList.add(direction);
    } else {
      profitTrend.textContent = "--";
      profitTrend.classList.add("flat");
    }
  }
  const profitSparkline = document.getElementById("dashboardProfitSparkline");
  if (profitSparkline) {
    const profitLabels = data?.charts?.profit_fy?.labels || [];
    const profitSeries = maskFutureSeries(data, profitLabels, data?.charts?.profit_fy?.actual_monthly_profit || [], null);
    profitSparkline.innerHTML = buildSparklineMarkup(cumulativeSeries(profitSeries));
  }
  const balanceValue = document.getElementById("dashboardBalanceValue");
  if (balanceValue) {
    balanceValue.classList.remove("positive", "negative");
    if (isPastFy) {
      balanceValue.textContent = fmtCurrency(sumNumeric(data?.charts?.sales_fy?.actual_monthly || []));
      balanceValue.classList.add("positive");
    } else {
      balanceValue.textContent = Number.isFinite(balanceKpi.balance) ? fmtCurrency(balanceKpi.balance) : "--";
      if (Number.isFinite(balanceKpi.balance)) balanceValue.classList.add(balanceKpi.balance < 0 ? "negative" : "positive");
    }
  }
  const balanceTrend = document.getElementById("dashboardBalanceTrend");
  if (balanceTrend) {
    balanceTrend.classList.remove("up", "down", "flat");
    if (isPastFy) {
      balanceTrend.textContent = "FY total";
      balanceTrend.classList.add("flat");
    } else if (Number.isFinite(balanceKpi.changePct)) {
      const direction = balanceKpi.changePct > 0 ? "up" : (balanceKpi.changePct < 0 ? "down" : "flat");
      balanceTrend.textContent = `${direction === "up" ? "+" : (direction === "down" ? "-" : "=")} ${Math.round(Math.abs(balanceKpi.changePct))}% vs PM`;
      balanceTrend.classList.add(direction);
    } else {
      balanceTrend.textContent = "--";
      balanceTrend.classList.add("flat");
    }
  }
  const balanceSparkline = document.getElementById("dashboardBalanceSparkline");
  if (balanceSparkline) {
    const cumulativeBalanceSeries = isPastFy ? cumulativeSeries(data?.charts?.sales_fy?.actual_monthly || []) : cumulativeSeries(balanceKpi.monthlyNet || []);
    balanceSparkline.innerHTML = buildSparklineMarkup(cumulativeBalanceSeries);
  }
  renderBalanceAdjustState(balanceKpi, isPastFy);
  const currentLiabilities = Number.isFinite(Number(data?.kpis?.current_liabilities)) ? Number(data.kpis.current_liabilities) : 0;
  const freeBalance = Number.isFinite(balanceKpi.balance) ? balanceKpi.balance - currentLiabilities : balanceKpi.balance;
  // Option B: render free cash bar
  const freeCashBar = document.getElementById("dashboardFreeCashBar");
  const freeCashFill = document.getElementById("dashboardFreeCashFill");
  const freeCashLabel = document.getElementById("dashboardFreeCashLabel");
  const committedLabel = document.getElementById("dashboardCommittedLabel");
  if (!isPastFy && freeCashBar && Number.isFinite(balanceKpi.balance) && balanceKpi.balance > 0 && currentLiabilities > 0) {
    const pctFree = Math.min(100, Math.max(0, (freeBalance / balanceKpi.balance) * 100));
    freeCashFill.style.width = `${pctFree}%`;
    freeCashLabel.textContent = `${fmtCurrency(Math.max(0, freeBalance))} free`;
    committedLabel.textContent = `${fmtCurrency(currentLiabilities)} committed`;
    freeCashBar.style.display = "";
  } else if (freeCashBar) {
    freeCashBar.style.display = "none";
  }
  const runwayValue = document.getElementById("dashboardRunwayValue");
  // Option C: use free cash for runway so days reflect cash after ATO commitments
  const forwardRunway = !isPastFy ? computeForwardRunwayMetrics(data, freeBalance) : null;
  if (runwayValue) {
    runwayValue.classList.remove("positive", "negative", "warning");
    if (isPastFy) {
      runwayValue.textContent = fmtCurrency(sumNumeric(data?.charts?.expenses_fy?.actual_monthly || []));
      runwayValue.classList.add("negative");
    } else {
      // Prefer budget-based forward runway (free-cash-aware).
      // Fall back to freeBalance / monthly_burn so liabilities are still subtracted.
      // Never fall back to kpis.runway_months — that uses gross balance and ignores liabilities.
      const monthlyBurn = Number(kpis.monthly_burn);
      const burnFallbackMonths = Number.isFinite(freeBalance) && Number.isFinite(monthlyBurn) && monthlyBurn > 0
        ? freeBalance / monthlyBurn
        : NaN;
      const runwayMonths = Number.isFinite(forwardRunway?.runwayMonths)
        ? Number(forwardRunway.runwayMonths)
        : burnFallbackMonths;
      const runwayDays = Number.isFinite(runwayMonths) ? Math.round(runwayMonths * 30) : null;
      if (forwardRunway?.basis === "already-negative") {
        runwayValue.textContent = "0 Days";
        runwayValue.classList.add("negative");
      } else if (runwayMonths === Number.POSITIVE_INFINITY) {
        runwayValue.textContent = "365+ Days";
        runwayValue.classList.add("positive");
      } else {
        runwayValue.textContent = runwayDays !== null ? `${runwayDays} Days` : "--";
        if (runwayDays !== null) {
          if (runwayDays <= 30) runwayValue.classList.add("negative");
          else if (runwayDays <= 90) runwayValue.classList.add("warning");
          else runwayValue.classList.add("positive");
        }
      }
    }
  }
  const burnNote = document.getElementById("dashboardBurnNote");
  if (burnNote) {
    burnNote.classList.remove("up", "down", "flat");
    if (isPastFy) {
      burnNote.textContent = "FY total";
      burnNote.classList.add("flat");
    } else {
      const futureNet = forwardRunway?.futureNet || [];
      const fyNet = futureNet.reduce((a, b) => a + b, 0);
      // Derive popover revenue/expense from the same slice used by computeForwardRunwayMetrics
      // so they are always consistent with futureNet (same null-filtering, same cutoff).
      const labels = data?.charts?.sales_fy?.labels || data?.charts?.expenses_fy?.labels || [];
      const asOfMonth = data?.meta?.as_of_month;
      const cutoffIdx = asOfMonth ? labels.indexOf(asOfMonth) : -1;
      const revenueProjected = data?.charts?.sales_fy?.projected_monthly || [];
      const expenseProjected = data?.charts?.expenses_fy?.projected_monthly || [];
      let fyRevenue = 0, fyExpense = 0;
      labels.forEach((_, idx) => {
        if (idx <= cutoffIdx) return;
        const rev = Number(revenueProjected[idx]);
        const exp = Number(expenseProjected[idx]);
        if (!Number.isFinite(rev) || !Number.isFinite(exp)) return;
        fyRevenue += rev;
        fyExpense += exp;
      });
      const monthsLeft = futureNet.length;
      burnNote.dataset.fyRevenue   = fyRevenue;
      burnNote.dataset.fyExpense   = fyExpense;
      burnNote.dataset.fyNet       = fyNet;
      burnNote.dataset.monthsLeft  = monthsLeft;
      burnNote.dataset.committed   = currentLiabilities;
      burnNote.dataset.freeBalance = Math.max(0, freeBalance);
      const burnHint = document.getElementById("dashboardBurnNoteHint");
      if (burnHint) burnHint.style.display = futureNet.length ? "" : "none";
      burnNote.style.color = "";
      if (!futureNet.length) {
        burnNote.textContent = "No budget data";
        burnNote.classList.add("flat");
      } else if (fyNet >= 0) {
        burnNote.textContent = `Projected net +${fmtCurrency(fyNet)} to FY end`;
        burnNote.style.color = "#3b82f6";
      } else {
        burnNote.textContent = `Projected net -${fmtCurrency(Math.abs(fyNet))} to FY end`;
        burnNote.style.color = "#ec4899";
      }
    }
  }
  renderCashTimeline(data, balanceKpi.balance, isPastFy);
  renderOverviewCharts(data);
  renderDashboardRecentTransactions();
}

async function showDashboard(options = {}) {
  hideAllViews();
  if (typeof setActiveSidebarNav === "function") setActiveSidebarNav("dashboard");
  const forceRefresh = Boolean(options?.forceRefresh);
  const todayOverride = selectedOverviewToday();
  const qs = buildOverviewQueryString(todayOverride, 7, null, null);
  const cachedEntry = forceRefresh ? null : getCachedOverviewEntry(qs);
  const cachedData = cachedEntry?.data || null;
  if (cachedData) {
    setRawData(cachedData);
    document.getElementById("dashboardContainer").style.display = "block";
    renderOverview(cachedData);
    if ((Date.now() - Number(cachedEntry?.cachedAt || 0)) > 30000) {
      fetchOverview(todayOverride, 7, null, null, { forceRefresh: true }).then((freshData) => {
        const dashboardVisible = document.getElementById("dashboardContainer")?.style.display !== "none";
        if (dashboardVisible && freshData) renderOverview(freshData);
      }).catch(() => {});
    }
    return;
  }
  setLoading("Preparing dashboard...");
  try {
    const data = await fetchOverview(todayOverride, 7, null, null, { forceRefresh });
    stopLoading();
    document.getElementById("dashboardContainer").style.display = "block";
    renderOverview(data);
  } catch (e) {
    stopLoading();
    showError(e.message);
  }
}

async function fetchOverview(todayStr, fyStartMonth = 7, cashBalance = null, burnMonths = null, options = {}) {
  const forceRefresh = Boolean(options?.forceRefresh);
  const qs = buildOverviewQueryString(todayStr, fyStartMonth, cashBalance, burnMonths);
  if (!forceRefresh) {
    const cachedData = getCachedOverview(qs);
    if (cachedData) {
      setRawData(cachedData);
      return cachedData;
    }
  }
  const data = await XeroAPI.fetch_json(`/api/dashboard/overview${qs}`);
  setRawData(data);
  setCachedOverview(qs, data);
  return data;
}

window.showDashboard = showDashboard;
window.fetchOverview = fetchOverview;
