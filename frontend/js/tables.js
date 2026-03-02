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
  if (amount === undefined || amount === null || amount === "") return "";
  const n = Number(amount);
  if (!Number.isFinite(n)) return String(amount);

  if (currencyCode) {
    try {
      return n.toLocaleString(undefined, { style: "currency", currency: currencyCode });
    } catch {
      return `${currencyCode} ${n.toFixed(2)}`.trim();
    }
  }
  return n.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

function escapeHtml(s) {
  return String(s ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function renderTable(columns, rows) {
  const thead = document.getElementById("tableHeader");
  const tbody = document.getElementById("tableBody");
  if (!thead || !tbody) return;

  thead.innerHTML = `<tr>${columns.map(c => `<th>${escapeHtml(c.label)}</th>`).join("")}</tr>`;
  tbody.innerHTML = rows
    .map((r, index) => `<tr data-row-index="${index}" tabindex="0">${columns.map(c => `<td>${c.render ? c.render(r) : escapeHtml(r[c.key])}</td>`).join("")}</tr>`)
    .join("");

  const toggleSelectedRow = (target) => {
    const row = target?.closest?.("tr");
    if (!row || row.parentElement !== tbody) return;
    row.classList.toggle("is-selected");
  };

  tbody.onclick = (event) => {
    toggleSelectedRow(event.target);
  };
  tbody.onkeydown = (event) => {
    if (event.key !== "Enter" && event.key !== " ") return;
    event.preventDefault();
    toggleSelectedRow(event.target);
  };
}

window.XeroTables = { parseXeroDate, formatDate, formatCurrency, renderTable };
