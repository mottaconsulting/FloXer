let charts = {};

function renderChart(name, canvasId, type, chartData, options = {}) {
  const el = document.getElementById(canvasId);
  if (!el || !window.Chart) return;

  if (charts[name]) charts[name].destroy();

  charts[name] = new Chart(el.getContext("2d"), {
    type,
    data: chartData,
    options: { responsive: true, maintainAspectRatio: false, ...options }
  });
}

window.XeroCharts = { renderChart };