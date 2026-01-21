function parseXeroDate(dateString) {
  if (!dateString) return new Date(0);
  if (typeof dateString === "string" && dateString.startsWith("/Date(")) {
    const m = dateString.match(/\/Date\((\d+)[\+\-]\d+\)\//);
    if (m) return new Date(parseInt(m[1], 10));
  }
  return new Date(dateString);
}

function formatDate(dateString) {
  const d = parseXeroDate(dateString);
  return isNaN(d.getTime()) ? "N/A" : d.toLocaleDateString();
}

function formatCurrency(amount, currencyCode) {
  if (amount === undefined || amount === null) return "N/A";
  return `${currencyCode || ""} ${Number(amount).toFixed(2)}`.trim();
}

window.XeroTables = { parseXeroDate, formatDate, formatCurrency };
