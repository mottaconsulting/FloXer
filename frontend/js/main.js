let currentData = null;
let showingRaw = false;

function resetUI(msg) {
  document.getElementById("loading").innerText = msg || "Loading...";
  document.getElementById("loading").style.display = "block";
  document.getElementById("error").style.display = "none";

  document.getElementById("tableContainer").style.display = "none";
  document.getElementById("rawOutput").style.display = "none";
  document.getElementById("summaryContainer").style.display = "none";
  document.getElementById("salesDashboard").style.display = "none";
  document.getElementById("budgetContainer").style.display = "none";
}

function stopLoading() {
  document.getElementById("loading").style.display = "none";
}

function showError(msg) {
  const el = document.getElementById("error");
  el.innerText = msg;
  el.style.display = "block";
}

async function loadInvoices() {
  resetUI("Loading invoices...");
  try {
    const data = await XeroAPI.fetch_json("/api/invoices");
    currentData = data;
    stopLoading();
    document.getElementById("rawOutput").innerText = JSON.stringify(data, null, 2);
    document.getElementById("rawOutput").style.display = "block";
  } catch (e) {
    stopLoading();
    showError(e.message);
  }
}

async function loadAccounts() {
  resetUI("Loading accounts...");
  try {
    const data = await XeroAPI.fetch_json("/api/accounts");
    currentData = data;
    stopLoading();
    document.getElementById("rawOutput").innerText = JSON.stringify(data, null, 2);
    document.getElementById("rawOutput").style.display = "block";
  } catch (e) {
    stopLoading();
    showError(e.message);
  }
}

async function loadJournals() {
  resetUI("Loading journals...");
  try {
    const data = await XeroAPI.fetch_json("/api/journals");
    currentData = data;
    stopLoading();
    document.getElementById("rawOutput").innerText = JSON.stringify(data, null, 2);
    document.getElementById("rawOutput").style.display = "block";
  } catch (e) {
    stopLoading();
    showError(e.message);
  }
}

async function loadContacts() {
  resetUI("Loading contacts...");
  try {
    const data = await XeroAPI.fetch_json("/api/contacts");
    currentData = data;
    stopLoading();
    document.getElementById("rawOutput").innerText = JSON.stringify(data, null, 2);
    document.getElementById("rawOutput").style.display = "block";
  } catch (e) {
    stopLoading();
    showError(e.message);
  }
}

async function loadSummary() {
  resetUI("Loading summary...");
  try {
    const data = await XeroAPI.fetch_json("/api/dashboard/summary");
    currentData = data;
    stopLoading();

    document.getElementById("totalSalesValue").innerText = `$${(data.total_sales||0).toFixed(2)}`;
    document.getElementById("totalExpensesValue").innerText = `$${(data.total_expenses||0).toFixed(2)}`;
    document.getElementById("netProfitValue").innerText = `$${(data.net_profit||0).toFixed(2)}`;

    document.getElementById("summaryContainer").style.display = "block";
  } catch (e) {
    stopLoading();
    showError(e.message);
  }
}

function showRawJson() {
  if (!currentData) return;
  const raw = document.getElementById("rawOutput");
  const table = document.getElementById("tableContainer");
  const btn = document.getElementById("rawJsonBtn");

  if (showingRaw) {
    raw.style.display = "none";
    table.style.display = "block";
    btn.innerText = "Show Raw JSON";
    showingRaw = false;
  } else {
    table.style.display = "none";
    raw.style.display = "block";
    raw.innerText = JSON.stringify(currentData, null, 2);
    btn.innerText = "Show Table";
    showingRaw = true;
  }
}

function authorize() {
  const w = XeroAPI.open_auth_popup();
  const timer = setInterval(() => {
    if (w.closed) {
      clearInterval(timer);
      setTimeout(checkHealth, 800);
    }
  }, 800);
}

async function checkHealth() {
  try {
    const data = await XeroAPI.fetch_json("/health");
    alert(JSON.stringify(data, null, 2));
  } catch (e) {
    showError(e.message);
  }
}

// expose for onclick buttons in HTML
window.loadInvoices = loadInvoices;
window.loadAccounts = loadAccounts;
window.loadJournals = loadJournals;
window.loadContacts = loadContacts;
window.loadSummary = loadSummary;
window.showRawJson = showRawJson;
window.authorize = authorize;
window.checkHealth = checkHealth;
