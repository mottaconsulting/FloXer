let _xeroUiCurrentData = null;
let _xeroUiShowingRaw = false;
let _xeroConnectModalLoadPromise = null;

function ensureXeroConnectModalLoaded() {
  const existing = document.getElementById("xeroConnectModal");
  if (existing) return Promise.resolve(existing);
  if (_xeroConnectModalLoadPromise) return _xeroConnectModalLoadPromise;

  const mount = document.getElementById("xeroConnectModalMount");
  if (!mount) return Promise.resolve(null);

  _xeroConnectModalLoadPromise = fetch("/partials/xero-connect-modal.html", { cache: "no-store" })
    .then(resp => {
      if (!resp.ok) throw new Error(`modal load failed: ${resp.status}`);
      return resp.text();
    })
    .then(html => {
      mount.innerHTML = html;
      return document.getElementById("xeroConnectModal");
    })
    .catch(() => null)
    .finally(() => {
      _xeroConnectModalLoadPromise = null;
    });

  return _xeroConnectModalLoadPromise;
}

function setLoading(msg) {
  const el = document.getElementById("loading");
  if (!el) return;
  el.textContent = msg || "Preparing dashboard...";
  el.style.display = "flex";
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

function showXeroConnectModal() {
  ensureXeroConnectModalLoaded().then(modal => {
    if (!modal) return;
    modal.classList.add("is-open");
    modal.setAttribute("aria-hidden", "false");
  });
}

function hideXeroConnectModal() {
  const modal = document.getElementById("xeroConnectModal");
  if (!modal) return;
  modal.classList.remove("is-open");
  modal.setAttribute("aria-hidden", "true");
}

document.addEventListener("DOMContentLoaded", () => {
  ensureXeroConnectModalLoaded();
});

function hideAllViews() {
  ["dashboardContainer", "transactionsContainer", "liabilitiesContainer", "budgetContainer", "rawOutput"].forEach(id => {
    const el = document.getElementById(id);
    if (el) el.style.display = "none";
  });
  if (typeof closeTransactionQuickView === "function") closeTransactionQuickView();
  stopLoading();
  hideError();
}

function setActiveSidebarNav(view) {
  document.querySelectorAll(".nav-links button[data-view]").forEach(button => {
    button.classList.toggle("is-active", button.dataset.view === view);
  });
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
    link.style.visibility = "visible";
  }
  if (select && !connected) {
    select.innerHTML = `<option value="">Organization</option>`;
    select.disabled = true;
  }
  if (connected) hideXeroConnectModal();
  else showXeroConnectModal();
}

window.XeroUI = {
  getRawData,
  hideAllViews,
  hideError,
  setActiveSidebarNav,
  setLoading,
  setRawData,
  hideXeroConnectModal,
  setXeroConnectionStatus,
  showXeroConnectModal,
  showError,
  showRawJson,
  stopLoading
};

window.hideAllViews = hideAllViews;
window.hideError = hideError;
window.setLoading = setLoading;
window.setRawData = setRawData;
window.setActiveSidebarNav = setActiveSidebarNav;
window.hideXeroConnectModal = hideXeroConnectModal;
window.setXeroConnectionStatus = setXeroConnectionStatus;
window.showXeroConnectModal = showXeroConnectModal;
window.showError = showError;
window.showRawJson = showRawJson;
window.stopLoading = stopLoading;
