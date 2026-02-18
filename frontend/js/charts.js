let charts = {};

const monthHighlightPlugin = {
  id: "monthHighlight",
  beforeDatasetsDraw(chart, args, opts) {
    const xScale = chart.scales?.x;
    const yScale = chart.scales?.y;
    if (!xScale || !yScale) return;
    const tickCount = xScale.ticks.length;
    if (!tickCount) return;

    const ctx = chart.ctx;

    const cutoffIndex = Number(opts?.cutoffIndex);
    if (Number.isInteger(cutoffIndex) && cutoffIndex >= 0 && cutoffIndex < tickCount - 1) {
      const splitX = (xScale.getPixelForValue(cutoffIndex) + xScale.getPixelForValue(cutoffIndex + 1)) / 2;
      const forecastRight = xScale.getPixelForValue(tickCount - 1) + ((xScale.getPixelForValue(tickCount - 1) - xScale.getPixelForValue(Math.max(tickCount - 2, 0))) / 2);
      ctx.save();
      ctx.fillStyle = opts?.forecastColor || "rgba(15, 23, 42, 0.045)";
      ctx.fillRect(splitX, yScale.top, forecastRight - splitX, yScale.bottom - yScale.top);
      ctx.strokeStyle = opts?.dividerColor || "rgba(15, 23, 42, 0.35)";
      ctx.lineWidth = 1.5;
      ctx.setLineDash([4, 4]);
      ctx.beginPath();
      ctx.moveTo(splitX, yScale.top);
      ctx.lineTo(splitX, yScale.bottom);
      ctx.stroke();
      ctx.setLineDash([]);
      ctx.font = "11px Source Sans 3, sans-serif";
      ctx.fillStyle = opts?.dividerColor || "rgba(15, 23, 42, 0.6)";
      ctx.fillText("Today", splitX + 6, yScale.top + 14);
      ctx.restore();
    }

    const index = Number(opts?.index);
    if (!Number.isInteger(index) || index < 0 || index >= tickCount) return;
    const x = xScale.getPixelForValue(index);
    const prev = xScale.getPixelForValue(Math.max(index - 1, 0));
    const next = xScale.getPixelForValue(Math.min(index + 1, tickCount - 1));
    const width = Math.max(12, Math.abs(next - prev) * 0.5);

    const left = x - width / 2;
    const top = yScale.top;
    const height = yScale.bottom - yScale.top;
    ctx.save();
    ctx.fillStyle = opts?.color || "rgba(15, 23, 42, 0.08)";
    ctx.fillRect(left, top, width, height);
    ctx.restore();
  }
};

if (window.Chart && !Chart.registry.plugins.get("monthHighlight")) {
  Chart.register(monthHighlightPlugin);
}

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
