let _xeroUiCurrentData = null;
let _xeroUiShowingRaw = false;

function setLoading(msg) {
  const el = document.getElementById("loading");
  if (!el) return;
  el.textContent = msg || "Loading...";
  el.style.display = "block";
}

function stopLoading() {
  const el = document.getElementById("loading");
  if (el) el.style.display = "none";
}

function showError(msg) {
  const el = document.getElementById("error");
  if (!el) return;
  el.innerText = msg;
  el.style.display = "block";
}

function hideError() {
  const el = document.getElementById("error");
  if (el) el.style.display = "none";
}

function hideAllViews() {
  ["dashboardContainer", "transactionsContainer", "liabilitiesContainer", "budgetContainer", "rawOutput"].forEach(id => {
    const el = document.getElementById(id);
    if (el) el.style.display = "none";
  });
  if (typeof closeTransactionQuickView === "function") closeTransactionQuickView();
  stopLoading();
  hideError();
}

function setRawData(data) {
  _xeroUiCurrentData = data;
  const raw = document.getElementById("rawOutput");
  if (raw) raw.innerText = JSON.stringify(data, null, 2);
}

function getRawData() {
  return _xeroUiCurrentData;
}

function showRawJson() {
  if (!_xeroUiCurrentData) return;
  const raw = document.getElementById("rawOutput");
  const btn = document.getElementById("rawJsonBtn");
  if (!raw || !btn) return;

  if (_xeroUiShowingRaw) {
    raw.style.display = "none";
    const dash = document.getElementById("dashboardContainer");
    if (dash) dash.style.display = "block";
    btn.innerText = "Show Raw JSON";
    _xeroUiShowingRaw = false;
    return;
  }

  ["dashboardContainer", "transactionsContainer", "liabilitiesContainer", "budgetContainer"].forEach(id => {
    const el = document.getElementById(id);
    if (el) el.style.display = "none";
  });
  raw.style.display = "block";
  raw.innerText = JSON.stringify(_xeroUiCurrentData, null, 2);
  btn.innerText = "Show UI";
  _xeroUiShowingRaw = true;
}

function setXeroConnectionStatus(connected) {
  const pill = document.getElementById("xeroConnectionPill");
  const link = document.getElementById("xeroConnectLink");
  const select = document.getElementById("orgSelect");

  if (pill) {
    pill.classList.toggle("connected", connected);
    pill.classList.toggle("disconnected", !connected);
    pill.textContent = connected ? "Xero: Connected" : "Xero: Not connected";
  }
  if (link) {
    link.style.display = connected ? "none" : "inline-flex";
  }
  if (select && !connected) {
    select.innerHTML = `<option value="">Organization</option>`;
    select.disabled = true;
  }
}

window.XeroUI = {
  getRawData,
  hideAllViews,
  hideError,
  setLoading,
  setRawData,
  setXeroConnectionStatus,
  showError,
  showRawJson,
  stopLoading
};

window.hideAllViews = hideAllViews;
window.hideError = hideError;
window.setLoading = setLoading;
window.setRawData = setRawData;
window.setXeroConnectionStatus = setXeroConnectionStatus;
window.showError = showError;
window.showRawJson = showRawJson;
window.stopLoading = stopLoading;
