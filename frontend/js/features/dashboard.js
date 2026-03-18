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
    profitValue.textContent = Number.isFinite(yearProfitKpi.yearProfit) ? fmtUSD(yearProfitKpi.yearProfit) : "--";
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
      balanceValue.textContent = fmtUSD(sumNumeric(data?.charts?.sales_fy?.actual_monthly || []));
      balanceValue.classList.add("positive");
    } else {
      balanceValue.textContent = Number.isFinite(balanceKpi.balance) ? fmtUSD(balanceKpi.balance) : "--";
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
  const runwayValue = document.getElementById("dashboardRunwayValue");
  const forwardRunway = !isPastFy ? computeForwardRunwayMetrics(data, balanceKpi.balance) : null;
  if (runwayValue) {
    runwayValue.classList.remove("positive", "negative");
    if (isPastFy) {
      runwayValue.textContent = fmtUSD(sumNumeric(data?.charts?.expenses_fy?.actual_monthly || []));
      runwayValue.classList.add("negative");
    } else {
      const runwayMonths = Number.isFinite(forwardRunway?.runwayMonths)
        ? Number(forwardRunway.runwayMonths)
        : Number(kpis.runway_months);
      if (runwayMonths === Number.POSITIVE_INFINITY) {
        runwayValue.textContent = "12+ Months";
        runwayValue.classList.add("positive");
      } else {
        runwayValue.textContent = Number.isFinite(runwayMonths) ? `${Math.round(runwayMonths)} Months` : "--";
        if (Number.isFinite(runwayMonths)) runwayValue.classList.add(runwayMonths <= 3 ? "negative" : "positive");
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
      const shortfall = Number(forwardRunway?.avgMonthlyShortfall);
      if (forwardRunway?.basis === "budget-surplus") {
        burnNote.textContent = "Budget projects positive cash flow";
      } else {
        burnNote.textContent = Number.isFinite(shortfall) && shortfall > 0
          ? `At ${fmtUSD(shortfall)} projected net outflow`
          : "Based on budget";
      }
    }
  }
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
