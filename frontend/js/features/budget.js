function applyBudgetUiState(data) {
  setRawData(data);
  const meta = document.getElementById("budgetMeta");
  const backendBadge = document.getElementById("budgetBackendBadge");
  const backend = String(data?.budget_backend || "--").toLowerCase();
  const source = data?.source || "--";
  if (meta) {
    meta.innerText = backend === "supabase" ? "Simple monthly budget saved to Supabase." : `Simple monthly budget saved to ${source}.`;
  }
  if (backendBadge) backendBadge.textContent = backend === "supabase" ? "Supabase connected" : "Local budget";
  renderBudgetRows(data?.rows || []);
}

const BUDGET_ACCOUNT_OPTIONS = {
  REVENUE: ["Sales", "Services", "Other income", "Custom"],
  EXPENSE: ["Wages", "Rent", "Marketing", "Software", "Travel", "Other", "Custom"]
};
let BUDGET_ROW_SEQ = 1;

function budgetAccountOptions(type) {
  return BUDGET_ACCOUNT_OPTIONS[String(type || "EXPENSE").toUpperCase()] || BUDGET_ACCOUNT_OPTIONS.EXPENSE;
}

function nextBudgetRowId() {
  const id = `budget-row-${BUDGET_ROW_SEQ}`;
  BUDGET_ROW_SEQ += 1;
  return id;
}

function escapeAttr(value) {
  return escapeHtmlText(value).replaceAll("`", "&#096;");
}

function budgetRowHtml(row = {}, idx = 0) {
  const dateValue = String(row.JOURNAL_DATE || row.journal_date || "").slice(0, 10);
  const typeValue = String(row.ACCOUNT_TYPE || row.account_type || "EXPENSE").toUpperCase();
  const nameValue = String(row.ACCOUNT_NAME || row.account_name || "");
  const rowId = String(row.ROW_ID || row.row_id || nextBudgetRowId());
  const generatedFrom = String(row.GENERATED_FROM || row.generated_from || "");
  let amountValue = Number(row.DISPLAY_AMOUNT ?? row.display_amount ?? row.NET_AMOUNT ?? row.net_amount ?? 0);
  if (typeValue === "REVENUE") amountValue = Math.abs(amountValue);
  const options = budgetAccountOptions(typeValue);
  const matchesPreset = options.some(option => option.toLowerCase() === nameValue.toLowerCase() && option !== "Custom");
  const selectedName = matchesPreset ? options.find(option => option.toLowerCase() === nameValue.toLowerCase()) : (nameValue ? "Custom" : options[0]);
  const customVisible = selectedName === "Custom";

  return `
    <tr data-budget-idx="${idx}" data-row-id="${escapeAttr(rowId)}" data-generated-from="${escapeAttr(generatedFrom)}">
      <td><input type="date" class="budget-date budget-input" value="${dateValue}"></td>
      <td>
        <select class="budget-type budget-select" onchange="updateBudgetRowUi(${idx})">
          <option value="REVENUE" ${typeValue === "REVENUE" ? "selected" : ""}>REVENUE</option>
          <option value="EXPENSE" ${typeValue === "EXPENSE" ? "selected" : ""}>EXPENSE</option>
        </select>
      </td>
      <td>
        <div class="budget-account-stack">
          <select class="budget-name-select budget-select" onchange="updateBudgetRowUi(${idx})">
            ${options.map(option => `<option value="${escapeAttr(option)}" ${option === selectedName ? "selected" : ""}>${escapeHtmlText(option)}</option>`).join("")}
          </select>
          <input type="text" class="budget-name budget-input budget-custom-name" value="${customVisible ? escapeAttr(nameValue) : ""}" placeholder="Custom account name" style="${customVisible ? "" : "display:none;"}">
        </div>
      </td>
      <td><input type="number" class="budget-amount budget-input" value="${Number.isFinite(amountValue) ? amountValue : 0}" step="0.01" oninput="updateBudgetRowUi(${idx})"></td>
      <td><div class="budget-row-actions"><button type="button" class="budget-delete-btn" onclick="removeBudgetRow(${idx})" aria-label="Delete row">&times;</button></div></td>
    </tr>`;
}

function budgetRowStateFromElement(tr) {
  const accountType = tr.querySelector(".budget-type")?.value || "";
  const selectedName = tr.querySelector(".budget-name-select")?.value || "";
  const customInput = tr.querySelector(".budget-name");
  const accountName = selectedName === "Custom" ? (customInput?.value || "").trim() : selectedName;
  const journalDate = tr.querySelector(".budget-date")?.value || "";
  const enteredAmount = Math.abs(Number(tr.querySelector(".budget-amount")?.value || 0));
  const rowId = tr.dataset.rowId || nextBudgetRowId();
  const generatedFrom = tr.dataset.generatedFrom || "";
  return { accountType, accountName, journalDate, enteredAmount, rowId, generatedFrom };
}

function collectBudgetUiRowsFromTable() {
  const body = document.getElementById("budgetBody");
  if (!body) return [];
  return Array.from(body.querySelectorAll("tr")).map(tr => {
    const state = budgetRowStateFromElement(tr);
    return { ROW_ID: state.rowId, GENERATED_FROM: state.generatedFrom, REPEAT: "ONE_OFF", ACCOUNT_TYPE: state.accountType, ACCOUNT_NAME: state.accountName, JOURNAL_DATE: state.journalDate, DISPLAY_AMOUNT: state.enteredAmount };
  });
}

function collectBudgetRowsFromTable() {
  return collectBudgetUiRowsFromTable().map(row => {
    const enteredAmount = Number(row.DISPLAY_AMOUNT || 0);
    return {
      ACCOUNT_TYPE: row.ACCOUNT_TYPE || "",
      ACCOUNT_NAME: row.ACCOUNT_NAME || "",
      DATA_CATEGORY: "Budget",
      JOURNAL_DATE: row.JOURNAL_DATE || "",
      NET_AMOUNT: row.ACCOUNT_TYPE === "REVENUE" ? -Math.abs(enteredAmount) : Math.abs(enteredAmount)
    };
  }).filter(r => r.ACCOUNT_NAME && r.JOURNAL_DATE);
}

function updateBudgetSummary() {
  const rows = collectBudgetRowsFromTable();
  const revenueTotal = rows.filter(row => row.ACCOUNT_TYPE === "REVENUE").reduce((sum, row) => sum + Math.abs(Number(row.NET_AMOUNT || 0)), 0);
  const expenseTotal = rows.filter(row => row.ACCOUNT_TYPE === "EXPENSE").reduce((sum, row) => sum + Math.abs(Number(row.NET_AMOUNT || 0)), 0);
  const rowCountEl = document.getElementById("budgetRowsCount");
  const revenueEl = document.getElementById("budgetRevenueTotal");
  const expenseEl = document.getElementById("budgetExpenseTotal");
  if (rowCountEl) rowCountEl.innerText = String(rows.length);
  if (revenueEl) revenueEl.innerText = fmtCurrency(revenueTotal);
  if (expenseEl) expenseEl.innerText = fmtCurrency(expenseTotal);
}

function updateBudgetRowUi(idx) {
  const body = document.getElementById("budgetBody");
  if (!body) return;
  const tr = body.querySelector(`tr[data-budget-idx="${idx}"]`);
  if (!tr) return;
  const typeEl = tr.querySelector(".budget-type");
  const selectEl = tr.querySelector(".budget-name-select");
  const customInput = tr.querySelector(".budget-name");
  const options = budgetAccountOptions(typeEl?.value || "EXPENSE");
  const keepExisting = options.includes(selectEl?.value || "") ? selectEl.value : "Custom";
  if (selectEl) {
    selectEl.innerHTML = options.map(option => `<option value="${escapeAttr(option)}" ${option === keepExisting ? "selected" : ""}>${escapeHtmlText(option)}</option>`).join("");
  }
  if (customInput) {
    customInput.style.display = keepExisting === "Custom" ? "" : "none";
    if (keepExisting !== "Custom") customInput.value = "";
  }
  updateBudgetSummary();
}

function syncBudgetRowsUi() {
  const body = document.getElementById("budgetBody");
  if (!body) return;
  Array.from(body.querySelectorAll("tr")).forEach((tr, idx) => {
    tr.dataset.budgetIdx = String(idx);
    const customInput = tr.querySelector(".budget-name");
    if (customInput) customInput.oninput = () => updateBudgetRowUi(idx);
    updateBudgetRowUi(idx);
  });
}

function renderBudgetRows(rows) {
  const body = document.getElementById("budgetBody");
  if (!body) return;
  body.innerHTML = !rows || !rows.length ? budgetRowHtml({}, 0) : rows.map((row, idx) => budgetRowHtml(row, idx)).join("");
  syncBudgetRowsUi();
}

async function loadBudgetRows(options = {}) {
  if (!document.getElementById("budgetBody")) {
    renderEmptyView("budgetContainer", "Budget Input", "This screen is not rebuilt yet.");
    stopLoading();
    return null;
  }
  const cachedData = options?.forceRefresh ? null : getCachedBudget();
  if (cachedData) {
    applyBudgetUiState(cachedData);
    return cachedData;
  }
  setLoading("Loading budget workspace...");
  try {
    const data = await XeroAPI.fetch_json("/api/budget");
    setCachedBudget(data);
    applyBudgetUiState(data);
    stopLoading();
    return data;
  } catch (e) {
    stopLoading();
    showError(e.message);
    return null;
  }
}

async function saveBudgetRows() {
  const rows = collectBudgetRowsFromTable();
  setLoading("Saving budget changes...");
  try {
    const data = await XeroAPI.request_json("/api/budget", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ rows }) });
    setCachedBudget(data);
    applyBudgetUiState(data);
    clearOverviewCache();
    try {
      const freshOverview = await fetchOverview(selectedOverviewToday(), 7, null, null, { forceRefresh: true });
      if (document.getElementById("dashboardContainer")?.style.display !== "none" && freshOverview) renderOverview(freshOverview);
    } catch (_) {}
    stopLoading();
  } catch (e) {
    stopLoading();
    showError(e.message);
  }
}

function addBudgetRow() {
  const rows = collectBudgetUiRowsFromTable();
  rows.push({ ROW_ID: nextBudgetRowId(), REPEAT: "ONE_OFF" });
  renderBudgetRows(rows);
}

function removeBudgetRow(idx) {
  const rows = collectBudgetUiRowsFromTable();
  renderBudgetRows(rows.filter((row, rowIdx) => rowIdx !== idx));
}

async function showBudgetInput() {
  hideAllViews();
  if (typeof setActiveSidebarNav === "function") setActiveSidebarNav("budget");
  document.getElementById("budgetContainer").style.display = "block";
  if (!document.getElementById("budgetBody")) {
    renderEmptyView("budgetContainer", "Budget Input", "This screen is not rebuilt yet.");
    return;
  }
  await loadBudgetRows();
}

window.showBudgetInput = showBudgetInput;
window.loadBudgetRows = loadBudgetRows;
window.saveBudgetRows = saveBudgetRows;
window.addBudgetRow = addBudgetRow;
window.removeBudgetRow = removeBudgetRow;
window.updateBudgetRowUi = updateBudgetRowUi;
