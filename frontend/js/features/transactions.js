async function getJournals() {
  if (JOURNAL_CACHE) return JOURNAL_CACHE;
  const data = await XeroAPI.fetch_json("/api/journals");
  JOURNAL_CACHE = data?.Journals || [];
  return JOURNAL_CACHE;
}

function flattenJournalLines(journals) {
  const rows = [];
  for (const j of journals || []) {
    const date = j.JournalDate || j.JournalDateString || j.Date || j.DateString;
    const lines = j.JournalLines || j.JournalLineItems || j.Lines || [];
    for (const line of lines) {
      rows.push({
        date,
        journalId: j.JournalID ?? j.JournalId ?? "",
        journalNumber: j.JournalNumber ?? "",
        accountType: line.AccountType ?? line.accountType ?? "",
        accountCode: line.AccountCode ?? line.accountCode ?? "",
        accountName: line.AccountName ?? line.accountName ?? "",
        description: line.Description ?? line.description ?? "",
        net: Number(line.NetAmount ?? line.GrossAmount ?? line.Net ?? 0)
      });
    }
  }
  return rows.sort((a, b) => (XeroTables.parseXeroDate(b.date)?.getTime?.() || 0) - (XeroTables.parseXeroDate(a.date)?.getTime?.() || 0));
}

function escapeHtmlText(value) {
  return String(value ?? "").replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;").replaceAll("'", "&#039;");
}

function formatJournalTypeLabel(type) {
  const map = { REVENUE: "Revenue", EXPENSE: "Expense", CURRLIAB: "Liability", BANK: "Bank", EQUITY: "Equity", FIXED: "Fixed asset", CURRENT: "Current asset" };
  return map[String(type || "").toUpperCase()] || "Other";
}

function transactionTypeTone(type) {
  const key = String(type || "").toUpperCase();
  if (key === "REVENUE") return "positive";
  if (key === "EXPENSE") return "negative";
  return "neutral";
}

function populateTransactionTypeFilter(lines) {
  const select = document.getElementById("filterType");
  if (!select) return;
  const values = [...new Set((lines || []).map(line => String(line.accountType || "").trim()).filter(Boolean))];
  select.innerHTML = `<option value="">All types</option>` + values.map(value => `<option value="${escapeHtmlText(value)}">${escapeHtmlText(formatJournalTypeLabel(value))}</option>`).join("");
}

function renderTransactionTable(lines) {
  const body = document.getElementById("tableBody");
  if (!body) return;
  const allRows = Array.isArray(lines) ? lines : [];
  const total = allRows.length;
  const maxPage = Math.max(1, Math.ceil(total / TX_PAGE_SIZE));
  TX_CURRENT_PAGE = Math.max(1, Math.min(TX_CURRENT_PAGE, maxPage));
  const start = (TX_CURRENT_PAGE - 1) * TX_PAGE_SIZE;
  const pageRows = allRows.slice(start, start + TX_PAGE_SIZE);
  const countChip = document.getElementById("transactionsCountChip");
  if (countChip) countChip.textContent = `${total.toLocaleString()} journal lines`;
  const summary = document.getElementById("txTableSummary");
  if (summary) {
    const from = total ? start + 1 : 0;
    const to = total ? Math.min(start + TX_PAGE_SIZE, total) : 0;
    summary.textContent = `Showing ${from}–${to} of ${total.toLocaleString()}`;
  }
  const prevBtn = document.getElementById("txPrevBtn");
  const nextBtn = document.getElementById("txNextBtn");
  const pageLabel = document.getElementById("txPageLabel");
  if (prevBtn) prevBtn.disabled = TX_CURRENT_PAGE <= 1;
  if (nextBtn) nextBtn.disabled = TX_CURRENT_PAGE >= maxPage;
  if (pageLabel) pageLabel.textContent = `Page ${TX_CURRENT_PAGE} of ${maxPage}`;
  if (!pageRows.length) {
    body.innerHTML = `<tr><td colspan="5" class="rebuilt-empty">No journal lines match the current filters.</td></tr>`;
    return;
  }
  body.innerHTML = pageRows.map((row, index) => {
    const amount = Number(row.net || 0);
    const tone = transactionTypeTone(row.accountType);
    return `
      <tr class="tx-row tx-row-${tone}" data-source-index="${start + index}" onclick="openTransactionQuickView(FILTERED_JOURNAL_LINES[${start + index}])">
        <td class="tx-date-cell">${escapeHtmlText(XeroTables.formatDate(row.date))}</td>
        <td class="tx-account-cell">${escapeHtmlText(row.accountName || "—")}</td>
        <td><span class="tx-type-pill ${tone}">${escapeHtmlText(formatJournalTypeLabel(row.accountType))}</span></td>
        <td class="tx-description-cell">${escapeHtmlText(row.description || "—")}</td>
        <td class="tx-money ${amount < 0 ? "money-in" : amount > 0 ? "money-out" : ""}">${escapeHtmlText(XeroTables.formatCurrency(amount))}</td>
      </tr>`;
  }).join("");
}

function applyTransactionFilters() {
  const account = (document.getElementById("filterAccount")?.value || "").trim().toLowerCase();
  const type = document.getElementById("filterType")?.value || "";
  const fromDate = (document.getElementById("filterFrom")?.value || "") ? new Date(`${document.getElementById("filterFrom").value}T00:00:00`) : null;
  const toDate = (document.getElementById("filterTo")?.value || "") ? new Date(`${document.getElementById("filterTo").value}T23:59:59`) : null;
  FILTERED_JOURNAL_LINES = (JOURNAL_LINES || []).filter((r) => {
    if (account) {
      const hay = `${r.accountName || ""} ${r.description || ""} ${r.accountCode || ""}`.toLowerCase();
      if (!hay.includes(account)) return false;
    }
    if (type && String(r.accountType || "") !== type) return false;
    const d = XeroTables.parseXeroDate(r.date);
    if (fromDate && d < fromDate) return false;
    if (toDate && d > toDate) return false;
    return true;
  });
  TX_CURRENT_PAGE = 1;
  renderTransactionFilterChips();
  renderTransactionTable(FILTERED_JOURNAL_LINES);
}

function resetTransactionFilters() {
  ["filterAccount", "filterFrom", "filterTo", "filterType"].forEach(id => {
    const el = document.getElementById(id);
    if (el) el.value = "";
  });
  FILTERED_JOURNAL_LINES = JOURNAL_LINES || [];
  TX_CURRENT_PAGE = 1;
  renderTransactionFilterChips();
  renderTransactionTable(FILTERED_JOURNAL_LINES);
}

function bindTransactionFilterEvents() {
  if (TX_FILTER_EVENTS_BOUND) return;
  TX_FILTER_EVENTS_BOUND = true;
  const search = document.getElementById("filterAccount");
  const type = document.getElementById("filterType");
  const from = document.getElementById("filterFrom");
  const to = document.getElementById("filterTo");
  if (search) search.addEventListener("input", () => applyTransactionFilters());
  [type, from, to].forEach(el => { if (el) el.addEventListener("change", () => applyTransactionFilters()); });
}

function changeTransactionPage(delta) {
  if (!FILTERED_JOURNAL_LINES) FILTERED_JOURNAL_LINES = JOURNAL_LINES || [];
  TX_CURRENT_PAGE += Number(delta || 0);
  renderTransactionTable(FILTERED_JOURNAL_LINES);
}

function getTransactionFilterState() {
  return { account: document.getElementById("filterAccount")?.value || "", type: document.getElementById("filterType")?.value || "", from: document.getElementById("filterFrom")?.value || "", to: document.getElementById("filterTo")?.value || "" };
}

function clearTransactionFilter(key) {
  const elementByKey = { account: "filterAccount", type: "filterType", from: "filterFrom", to: "filterTo" };
  const el = document.getElementById(elementByKey[key] || "");
  if (!el) return;
  el.value = "";
  applyTransactionFilters();
}

function renderTransactionFilterChips() {
  const container = document.getElementById("txActiveFilters");
  if (!container) return;
  const state = getTransactionFilterState();
  const chips = [];
  if (state.account) chips.push({ key: "account", label: `Account: ${state.account}` });
  if (state.type) chips.push({ key: "type", label: `Type: ${formatJournalTypeLabel(state.type)}` });
  if (state.from) chips.push({ key: "from", label: `From: ${state.from}` });
  if (state.to) chips.push({ key: "to", label: `To: ${state.to}` });
  if (!chips.length) {
    container.innerHTML = "";
    container.style.display = "none";
    return;
  }
  container.style.display = "none";
  container.innerHTML = chips.map(chip => `<span class="tx-filter-chip">${escapeHtmlText(chip.label)}<button type="button" aria-label="Remove ${escapeHtmlText(chip.label)}" onclick="clearTransactionFilter('${chip.key}')">&times;</button></span>`).join("") + `<button type="button" class="tx-clear-link" onclick="resetTransactionFilters()">Clear all</button>`;
}

function closeTransactionQuickView() {
  const panel = document.getElementById("txQuickView");
  if (!panel) return;
  panel.classList.remove("is-open");
  panel.setAttribute("aria-hidden", "true");
}

function openTransactionQuickView(row) {
  const panel = document.getElementById("txQuickView");
  const body = document.getElementById("txQuickViewBody");
  if (!panel || !body || !row) return;
  const amount = Number(row.net || 0);
  body.innerHTML = `
    <div class="tx-quickview-grid">
      <div class="tx-quickview-field"><span class="tx-quickview-label">Date</span><div class="tx-quickview-value">${escapeHtmlText(XeroTables.formatDate(row.date))}</div></div>
      <div class="tx-quickview-field"><span class="tx-quickview-label">Type</span><div class="tx-quickview-value">${escapeHtmlText(formatJournalTypeLabel(row.accountType))}</div></div>
      <div class="tx-quickview-field wide"><span class="tx-quickview-label">Account name</span><div class="tx-quickview-value">${escapeHtmlText(row.accountName || "—")}</div></div>
      <div class="tx-quickview-field"><span class="tx-quickview-label">Account code</span><div class="tx-quickview-value">${escapeHtmlText(row.accountCode || "—")}</div></div>
      <div class="tx-quickview-field"><span class="tx-quickview-label">Journal</span><div class="tx-quickview-value">${escapeHtmlText(row.journalNumber || "—")}</div></div>
      <div class="tx-quickview-field wide"><span class="tx-quickview-label">Description</span><div class="tx-quickview-value">${escapeHtmlText(row.description || "—")}</div></div>
      <div class="tx-quickview-field wide"><span class="tx-quickview-label">Journal ID</span><div class="tx-quickview-value">${escapeHtmlText(row.journalId || "—")}</div></div>
    </div>
    <div class="tx-quickview-money">
      <div class="tx-quickview-field"><span class="tx-quickview-label">Money in</span><div class="tx-quickview-value money-in">${escapeHtmlText(amount < 0 ? XeroTables.formatCurrency(Math.abs(amount)) : "—")}</div></div>
      <div class="tx-quickview-field"><span class="tx-quickview-label">Money out</span><div class="tx-quickview-value money-out">${escapeHtmlText(amount > 0 ? XeroTables.formatCurrency(amount) : "—")}</div></div>
      <div class="tx-quickview-field"><span class="tx-quickview-label">Net amount</span><div class="tx-quickview-value ${amount < 0 ? "money-in" : amount > 0 ? "money-out" : ""}">${escapeHtmlText(XeroTables.formatCurrency(amount))}</div></div>
    </div>`;
  panel.classList.add("is-open");
  panel.setAttribute("aria-hidden", "false");
}

function changeTransactionPageSize(value) {
  const parsed = Number(value || 50);
  TX_PAGE_SIZE = Number.isFinite(parsed) && parsed > 0 ? parsed : 50;
  TX_CURRENT_PAGE = 1;
  renderTransactionTable(FILTERED_JOURNAL_LINES || JOURNAL_LINES || []);
}

async function showTransactions() {
  hideAllViews();
  if (typeof setActiveSidebarNav === "function") setActiveSidebarNav("transactions");
  setLoading("Loading transactions...");
  try {
    if (!document.getElementById("tableHeader") || !document.getElementById("tableBody")) {
      renderEmptyView("transactionsContainer", "Transactions", "This screen is not rebuilt yet.");
      stopLoading();
      document.getElementById("transactionsContainer").style.display = "block";
      return;
    }
    const journals = await getJournals();
    JOURNAL_LINES = flattenJournalLines(journals);
    populateTransactionTypeFilter(JOURNAL_LINES);
    bindTransactionFilterEvents();
    setRawData({ journals_count: journals.length, journal_lines_count: JOURNAL_LINES.length });
    stopLoading();
    document.getElementById("transactionsContainer").style.display = "block";
    FILTERED_JOURNAL_LINES = JOURNAL_LINES;
    TX_CURRENT_PAGE = 1;
    TX_PAGE_SIZE = 50;
    renderTransactionFilterChips();
    renderTransactionTable(FILTERED_JOURNAL_LINES);
  } catch (e) {
    stopLoading();
    showError(e.message);
  }
}

window.applyTransactionFilters = applyTransactionFilters;
window.resetTransactionFilters = resetTransactionFilters;
window.changeTransactionPage = changeTransactionPage;
window.clearTransactionFilter = clearTransactionFilter;
window.closeTransactionQuickView = closeTransactionQuickView;
window.changeTransactionPageSize = changeTransactionPageSize;
window.showTransactions = showTransactions;
