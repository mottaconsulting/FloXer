// Overview orchestration: data helpers, chart rendering, series utilities

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

function monthKey(dateStr) {
  const d = XeroTables.parseXeroDate(dateStr);
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  return `${y}-${m}`;
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

  // Build liability-by-month lookup for projected expense adjustment
  const liabilitySchedule = [
    ...(data?.obligations?.future_known || []),
    ...(data?.obligations?.future_forecast || []),
  ];
  const liabByMonth = {};
  for (const l of liabilitySchedule) {
    liabByMonth[l.month] = (liabByMonth[l.month] || 0) + Number(l.amount || 0);
  }

  // Adjust a projected series to include liabilities for future months
  function addLiabsToProjected(series, labels, cutoffIdx) {
    return series.map((v, i) => {
      if (i <= cutoffIdx || v === null) return v;
      return (v || 0) + (liabByMonth[labels[i]] || 0);
    });
  }

  if (cashflow?.labels?.length && sales?.labels?.length && expenses?.labels?.length) {
    const revenueSeries = splitActualProjectedSeries(data, sales.labels, sales.actual_monthly || [], sales.projected_monthly || []);
    const expenseSeries = splitActualProjectedSeries(data, expenses.labels, expenses.actual_monthly || [], expenses.projected_monthly || []);
    const cutoffIdx = revenueSeries.cutoffIdx;
    const expCombinedAdj = addLiabsToProjected(expenseSeries.combined, expenses.labels, cutoffIdx);
    let runningTotal = 0;
    const runningNet = revenueSeries.combined.map((rev, idx) => {
      const exp = expCombinedAdj[idx];
      if (rev === null || exp === null) return null;
      runningTotal += Number(rev || 0) - Number(exp || 0);
      return runningTotal;
    });

    XeroCharts.renderChart("dashboardCashflow", "dashboardCashflowChart", "bar", {
      labels: monthInitialLabels(sales.labels),
      datasets: [
        {
          label: "Cumulative Net",
          data: runningNet,
          backgroundColor: runningNet.map((v, idx) => {
            const isFuture = !isPastFinancialYearSelection(data) && idx > cutoffIdx;
            if (Number(v || 0) < 0) return isFuture ? "rgba(236,72,153,0.42)" : "rgba(236,72,153,0.84)";
            return isFuture ? "rgba(59,130,246,0.42)" : "rgba(59,130,246,0.82)";
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
        y: {
          grid: {
            color: ctx => ctx.tick.value === 0 ? "rgba(55,65,81,0.4)" : "rgba(226,232,240,0.7)"
          }
        }
      }
    });
  }

  if (sales?.labels?.length && expenses?.labels?.length) {
    const revenueSeries = splitActualProjectedSeries(data, sales.labels, sales.actual_monthly || [], sales.projected_monthly || []);
    const expenseSeries = splitActualProjectedSeries(data, expenses.labels, expenses.actual_monthly || [], expenses.projected_monthly || []);
    const expProjectedAdj = addLiabsToProjected(expenseSeries.projectedOnly, expenses.labels, revenueSeries.cutoffIdx);

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
          data: expProjectedAdj,
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
              const isProjected = ctx.dataset.label.includes("Projection");
              const isExpenseProjection = ctx.dataset.label === "Expenses Projection";
              if (isExpenseProjection) {
                return `Projected ${label} incl. future tax: ${fmtCurrency(Number(ctx.parsed?.y || 0))}`;
              }
              const prefix = isProjected ? "Projected " : "";
              return `${prefix}${label}: ${fmtCurrency(Number(ctx.parsed?.y || 0))}`;
            },
            footer: (items) => {
              if (!items?.length) return "";
              const monthLabel = sales.labels?.[items[0].dataIndex];
              if (!monthLabel) return "";
              const taxAmount = Number(liabByMonth[monthLabel] || 0);
              if (taxAmount <= 0) return "";
              const hasExpenseProjection = items.some(item => item.dataset?.label === "Expenses Projection");
              return hasExpenseProjection ? `Includes future tax obligations: ${fmtCurrency(taxAmount)}` : "";
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
