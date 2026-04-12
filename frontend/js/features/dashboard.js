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

    // If override is active, reset immediately — no prompt needed
    if (balanceKpi.hasManualOverride) {
      setBalanceOverrideValue(data || {}, null);
      if (data) renderOverview(data);
      return;
    }

    // Otherwise prompt for a new value
    const defaultValue = Number.isFinite(balanceKpi.balance) ? String(Math.round(balanceKpi.balance)) : "";
    const raw = window.prompt("Edit Bank Balance. Leave blank to cancel.", defaultValue);
    if (raw === null) return;
    const next = String(raw).trim();
    if (!next) return;
    const parsed = parseCurrencyInput(next);
    if (!Number.isFinite(parsed)) {
      showError("Enter a valid number for Bank Balance.");
      return;
    }
    setBalanceOverrideValue(data || {}, parsed);
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
          <span>Tax committed this month</span><span style="color:#ec4899;font-weight:700">-${fmtNum(committed)}</span>
        </div>
      </div>` : "";
    pop.innerHTML = `
      <div style="font-weight:700;color:#0d1b4b;margin-bottom:6px">Remaining FY budget</div>
      <div style="color:#6b7280;font-size:12px;margin-bottom:10px">${sentence}</div>
      <div style="display:grid;grid-template-columns:1fr auto;gap:2px 16px;color:#374151">
        <span>Revenue</span><span style="color:#3b82f6;font-weight:700">+${fmtNum(rev)}</span>
        <span>Expenses</span><span style="color:#ec4899;font-weight:700">-${fmtNum(exp)}</span>
        <span style="border-top:1px solid #dbe2ea;padding-top:6px;margin-top:4px;font-weight:700">Projected closing cash</span>
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
  const sourceEl  = document.getElementById("dashboardBalanceSource");
  const banner    = document.getElementById("dashboardUnreconciledBanner");
  if (!toggleBtn || !sourceEl) return;
  toggleBtn.style.display = isPastFy ? "none" : "inline-flex";
  if (balanceKpi.hasManualOverride) {
    toggleBtn.textContent = "Reset to Xero";
    toggleBtn.style.color = "#6b7280";
    sourceEl.textContent = "Estimated — unreconciled";
    sourceEl.style.color = "#6b7280";
  } else {
    toggleBtn.textContent = "Edit";
    toggleBtn.style.color = "";
    sourceEl.textContent = "";
    sourceEl.style.color = "";
  }
  sourceEl.classList.toggle("is-visible", Boolean(sourceEl.textContent));
  if (banner) banner.style.display = balanceKpi.hasManualOverride && !isPastFy ? "" : "none";
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
  if (secondKpiLabel) secondKpiLabel.textContent = isPastFy ? "Total Revenue" : "Bank Balance";
  if (thirdKpiLabel) thirdKpiLabel.textContent = isPastFy ? "Total Expenses" : "Out of Cash";
  const graphFyCash = document.getElementById("graphFyLabelCashflow");
  const graphFyRevenue = document.getElementById("graphFyLabelRevenue");
  if (graphFyCash) graphFyCash.textContent = fyLabel;
  if (graphFyRevenue) graphFyRevenue.textContent = fyLabel;
  const fyEndYear = data?.meta?.fy_end ? Number(String(data.meta.fy_end).slice(0, 4)) : null;
  const profitLabel = document.getElementById("dashboardProfitLabel");
  if (profitLabel) {
    profitLabel.textContent = Number.isFinite(fyEndYear)
      ? `Profit YTD (FY ${fyEndYear - 1}-${fyEndYear})`
      : "Profit YTD";
  }
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
  const committedCash = !balanceKpi.hasManualOverride && Number.isFinite(balanceKpi.committedCash)
    ? Number(balanceKpi.committedCash) : 0;
  const freeBalance = Number.isFinite(balanceKpi.freeCash) ? balanceKpi.freeCash : balanceKpi.balance;
  // Free cash bar: only show when using Xero balance (liabilities are already known in manual override)
  const freeCashBar = document.getElementById("dashboardFreeCashBar");
  const freeCashFill = document.getElementById("dashboardFreeCashFill");
  const freeCashLabel = document.getElementById("dashboardFreeCashLabel");
  const committedLabel = document.getElementById("dashboardCommittedLabel");
  if (!isPastFy && !balanceKpi.hasManualOverride && freeCashBar && Number.isFinite(balanceKpi.balance) && balanceKpi.balance > 0 && committedCash > 0) {
    const pctFree = Math.min(100, Math.max(0, (freeBalance / balanceKpi.balance) * 100));
    freeCashFill.style.width = `${pctFree}%`;
    freeCashLabel.textContent = `${fmtCurrency(Math.max(0, freeBalance))} free`;
    committedLabel.textContent = `${fmtCurrency(committedCash)} tax committed`;
    freeCashBar.style.display = "";
  } else if (freeCashBar) {
    freeCashBar.style.display = "none";
  }
  const runwayValue = document.getElementById("dashboardRunwayValue");
  // Drive Out of Cash from the cash timeline — same logic as the Cash Timeline page.
  // Timeline uses _bestOf(actual, budget) per month and places liabilities at their real due months,
  // which is more accurate than the old computeForwardRunwayMetrics approach.
  const timeline = !isPastFy ? buildCashTimeline(data, freeBalance) : null;
  const timelineRows = timeline?.rows || [];
  const firstNegIdx = timeline?.firstNegativeIdx ?? -1;
  const outOfCash = data?.projection?.out_of_cash || {};
  if (runwayValue) {
    runwayValue.classList.remove("positive", "negative", "warning");
    runwayValue.style.fontSize = "";
    if (isPastFy) {
      runwayValue.textContent = fmtCurrency(sumNumeric(data?.charts?.expenses_fy?.actual_monthly || []));
      runwayValue.classList.add("negative");
    } else if (freeBalance <= 0) {
      // Already committed more than available — out of cash now
      runwayValue.textContent = "Now";
      runwayValue.classList.add("negative");
    } else if (!timelineRows.length) {
      // No budget data — fall back to freeBalance / monthly_burn
      const monthlyBurn = Number(kpis.monthly_burn);
      const fallbackDays = Number.isFinite(monthlyBurn) && monthlyBurn > 0
        ? Math.round((freeBalance / monthlyBurn) * 30) : null;
      runwayValue.textContent = fallbackDays !== null ? `${fallbackDays} Days` : "--";
      if (fallbackDays !== null) {
        if (fallbackDays <= 30) runwayValue.classList.add("negative");
        else if (fallbackDays <= 90) runwayValue.classList.add("warning");
        else runwayValue.classList.add("positive");
      }
    } else if (outOfCash.cash_positive_through_fy_end || firstNegIdx < 0) {
      // Projected free cash stays positive through FY end
      runwayValue.textContent = "Positive through FY end";
      runwayValue.style.fontSize = "15px";
      runwayValue.classList.add("positive");
    } else {
      const runwayDays = Number(outOfCash.days_until_out_of_cash);
      runwayValue.textContent = `${runwayDays} Days`;
      if (runwayDays <= 30) runwayValue.classList.add("negative");
      else if (runwayDays <= 90) runwayValue.classList.add("warning");
      else runwayValue.classList.add("positive");
    }
  }
  const runwayBalance = document.getElementById("dashboardRunwayBalance");
  if (runwayBalance && !isPastFy && Number.isFinite(balanceKpi.balance)) {
    const startCol = freeBalance >= 0 ? "#1e2a78" : "#ec4899";
    runwayBalance.innerHTML = `Free cash starting point <strong style="color:${startCol}">${fmtCurrency(freeBalance)}</strong>`;
    runwayBalance.classList.add("is-visible");
  } else if (runwayBalance) {
    runwayBalance.textContent = "";
    runwayBalance.classList.remove("is-visible");
  }
  const burnNote = document.getElementById("dashboardBurnNote");
  if (burnNote) {
    burnNote.classList.remove("up", "down", "flat");
    if (isPastFy) {
      burnNote.textContent = "FY total";
      burnNote.classList.add("flat");
    } else {
      // Derive fyRevenue/fyExpense using the same _bestOf(actual, budget) logic as the timeline
      const salesChart = data?.charts?.sales_fy || {};
      const expensesChart = data?.charts?.expenses_fy || {};
      const labels = salesChart.labels || expensesChart.labels || [];
      const asOfMonth = data?.meta?.as_of_month;
      const cutoffIdx = asOfMonth ? labels.indexOf(asOfMonth) : -1;
      const revenueActual = salesChart.actual_monthly || [];
      const revenueProjected = salesChart.projected_monthly || [];
      const expenseActual = expensesChart.actual_monthly || [];
      const expenseProjected = expensesChart.projected_monthly || [];
      let fyRevenue = 0, fyExpense = 0;
      labels.forEach((_, idx) => {
        if (idx <= cutoffIdx) return;
        const rev = _bestOf(revenueActual[idx], revenueProjected[idx]);
        const exp = _bestOf(expenseActual[idx], expenseProjected[idx]);
        if (!Number.isFinite(rev) || !Number.isFinite(exp)) return;
        fyRevenue += rev;
        fyExpense += exp;
      });
      const fyNet = timelineRows.reduce((s, r) => r.budgetNet !== null ? s + r.budgetNet : s, 0);
      const monthsLeft = timelineRows.filter(r => r.budgetNet !== null).length;
      burnNote.dataset.fyRevenue   = fyRevenue;
      burnNote.dataset.fyExpense   = fyExpense;
      burnNote.dataset.fyNet       = fyNet;
      burnNote.dataset.monthsLeft  = monthsLeft;
      burnNote.dataset.committed   = committedCash;
      burnNote.dataset.freeBalance = Math.max(0, freeBalance);
      const burnHint = document.getElementById("dashboardBurnNoteHint");
      if (burnHint) burnHint.style.display = timelineRows.length ? "" : "none";
      burnNote.style.color = "";
      if (!timelineRows.length) {
        burnNote.textContent = "No budget data";
        burnNote.classList.add("flat");
      } else {
        const futureKnown = data?.obligations?.future_known || [];
        const futureForecast = data?.obligations?.future_forecast || [];
        const futureOblig  = [...futureKnown, ...futureForecast].reduce((s, l) => s + Number(l.amount || 0), 0);
        const taxTotal     = [...futureKnown, ...futureForecast]
          .filter(l => String(l.type || "").toLowerCase() !== "payable")
          .reduce((s, l) => s + Number(l.amount || 0), 0);
        const combinedNet  = freeBalance + fyNet - futureOblig;

        // Populate breakdown
        const ocBreakdown = document.getElementById("dashboardOcBreakdown");
        if (ocBreakdown) {
          const set = (id, val) => { const el = document.getElementById(id); if (el) el.textContent = val; };
          const balanceEl = document.getElementById("ocBalance");
          if (balanceEl) {
            balanceEl.textContent = fmtCurrency(freeBalance);
            const labelEl = balanceEl.previousElementSibling;
            if (labelEl) labelEl.textContent = "Free cash starting point";
          }
          set("ocRevenue",  `+${fmtCurrency(fyRevenue)}`);
          set("ocExpenses", `-${fmtCurrency(fyExpense)}`);
          set("ocTax",      taxTotal     > 0 ? `-${fmtCurrency(taxTotal)}`     : "—");
          const ocNetEl = document.getElementById("ocNet");
          if (ocNetEl) {
            ocNetEl.textContent = combinedNet >= 0 ? `+${fmtCurrency(combinedNet)}` : `-${fmtCurrency(Math.abs(combinedNet))}`;
            ocNetEl.className = `oc-val ${combinedNet >= 0 ? "oc-pos" : "oc-neg"}`;
          }
          const ocCard = ocBreakdown.closest(".oc-card");
          if (ocCard && !ocCard.dataset.ocBound) {
            ocCard.dataset.ocBound = "1";
            ocCard.addEventListener("click", () => {
              ocBreakdown.style.display = ocBreakdown.style.display === "none" ? "" : "none";
            });
          }
        }

        if (combinedNet >= 0 && freeBalance <= 0) {
          burnNote.textContent = `Free cash is negative now; projected closing cash +${fmtCurrency(combinedNet)} at FY end`;
          burnNote.style.color = "#2563eb";
        } else if (combinedNet >= 0) {
          burnNote.textContent = `Projected closing cash +${fmtCurrency(combinedNet)} at FY end`;
          burnNote.style.color = "#2563eb";
        } else if (freeBalance <= 0) {
          burnNote.textContent = `Free cash is negative now; projected closing cash -${fmtCurrency(Math.abs(combinedNet))} at FY end`;
          burnNote.style.color = "#ec4899";
        } else {
          burnNote.textContent = `Projected closing cash -${fmtCurrency(Math.abs(combinedNet))} at FY end`;
          burnNote.style.color = "#ec4899";
        }
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
