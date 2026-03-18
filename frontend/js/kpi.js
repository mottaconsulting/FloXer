// KPI computation and DOM rendering helpers

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
  valueEl.innerText = isCurrency ? fmtCurrency(num) : `${num.toFixed(1)}${suffix}`;

  if (colorize) {
    valueEl.style.color = num >= 0 ? "#2f6e5f" : "#a85536";
  }
  if (metaEl) metaEl.innerText = suffix ? suffix.replace(/^\s*/, "") : metaEl.innerText;
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
