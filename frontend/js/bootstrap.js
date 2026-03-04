async function logoutSession() {
  try {
    await XeroAPI.fetch_json("/auth/logout");
  } catch (_) {
    // Even if the API call fails, force navigation to login.
  }
  window.location.href = "/";
}

function authorize() {
  const w = XeroAPI.open_auth_popup();
  if (!w) return;

  const timer = setInterval(() => {
    if (!w.closed) return;
    clearInterval(timer);
    setTimeout(async () => {
      await loadOrganizations();
      await showDashboard();
    }, 800);
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

async function loadOrganizations() {
  const select = document.getElementById("orgSelect");
  if (!select) return;

  try {
    const data = await XeroAPI.fetch_json("/connections");
    const connections = data?.connections || [];
    const savedTenantId = data?.saved_tenant_id || "";

    if (!connections.length) {
      setXeroConnectionStatus(false);
      select.innerHTML = `<option value="">No organizations</option>`;
      select.disabled = true;
      return;
    }

    select.innerHTML = connections
      .map(c => {
        const tenantId = c.tenantId || "";
        const tenantName = c.tenantName || c.tenantType || tenantId;
        const selected = tenantId === savedTenantId ? "selected" : "";
        return `<option value="${tenantId}" ${selected}>${tenantName}</option>`;
      })
      .join("");
    select.disabled = false;
    setXeroConnectionStatus(true);
  } catch (_) {
    setXeroConnectionStatus(false);
    select.innerHTML = `<option value="">Org unavailable</option>`;
    select.disabled = true;
  }
}

async function switchOrganization(tenantId) {
  if (!tenantId) return;
  setLoading("Switching organization...");
  try {
    await XeroAPI.fetch_json(`/set-tenant?tenantId=${encodeURIComponent(tenantId)}`);
    await showDashboard();
    stopLoading();
  } catch (e) {
    stopLoading();
    showError(e.message);
  }
}

function setSalesMode(mode) {
  window.SALES_MODE = mode;

  const monthlyBtn = document.getElementById("salesModeMonthly");
  const cumulativeBtn = document.getElementById("salesModeCumulative");
  if (monthlyBtn && cumulativeBtn) {
    monthlyBtn.classList.toggle("active", mode === "monthly");
    cumulativeBtn.classList.toggle("active", mode === "cumulative");
  }

  const data = window.XeroUI?.getRawData?.();
  if (data) renderOverviewCharts(data);
}

function fyEndDateFromYear(endYear) {
  const y = Number(endYear);
  if (!y) return null;
  return `${y}-06-30`;
}

window.addEventListener("message", async (event) => {
  if (event.origin !== window.location.origin) return;
  if (event.data?.type !== "xero-auth-success") return;
  await loadOrganizations();
  await showDashboard();
});

document.addEventListener("DOMContentLoaded", () => {
  const monthlyBtn = document.getElementById("salesModeMonthly");
  const cumulativeBtn = document.getElementById("salesModeCumulative");
  const dateSelect = document.getElementById("overviewDateSelect");
  const fySelect = document.getElementById("fySelect");
  const cashInput = document.getElementById("cashBalanceInput");
  const burnMonthsInput = document.getElementById("burnMonthsInput");
  const liabFySelect = document.getElementById("liabFySelect");
  const orgSelect = document.getElementById("orgSelect");

  if (monthlyBtn) monthlyBtn.addEventListener("click", () => setSalesMode("monthly"));
  if (cumulativeBtn) cumulativeBtn.addEventListener("click", () => setSalesMode("cumulative"));

  if (dateSelect) {
    dateSelect.addEventListener("change", async (e) => {
      const val = e.target.value;
      if (!val) return;
      setLoading("Refreshing overview...");
      try {
        const data = await fetchOverview(val, 7, cashInput?.value, burnMonthsInput?.value);
        stopLoading();
        renderOverview(data);
      } catch (err) {
        stopLoading();
        showError(err.message);
      }
    });
  }

  if (fySelect) {
    fySelect.addEventListener("change", async (e) => {
      const endYear = e.target.value;
      const today = fyEndDateFromYear(endYear);
      if (!today) return;
      setLoading("Refreshing overview...");
      try {
        const data = await fetchOverview(today, 7, cashInput?.value, burnMonthsInput?.value);
        stopLoading();
        renderOverview(data);
      } catch (err) {
        stopLoading();
        showError(err.message);
      }
    });
  }

  if (cashInput) {
    const handler = async () => {
      const todayOverride = dateSelect?.value || null;
      setLoading("Refreshing overview...");
      try {
        const data = await fetchOverview(todayOverride, 7, cashInput.value, burnMonthsInput?.value);
        stopLoading();
        renderOverview(data);
      } catch (err) {
        stopLoading();
        showError(err.message);
      }
    };
    cashInput.addEventListener("change", handler);
    cashInput.addEventListener("blur", handler);
  }

  if (burnMonthsInput) {
    const handler = async () => {
      const todayOverride = dateSelect?.value || null;
      setLoading("Refreshing overview...");
      try {
        const data = await fetchOverview(todayOverride, 7, cashInput?.value, burnMonthsInput.value);
        stopLoading();
        renderOverview(data);
      } catch (err) {
        stopLoading();
        showError(err.message);
      }
    };
    burnMonthsInput.addEventListener("change", handler);
  }

  if (liabFySelect) {
    liabFySelect.addEventListener("change", async () => {
      setLoading("Refreshing liabilities...");
      try {
        await showLiabilities();
        stopLoading();
      } catch (err) {
        stopLoading();
        showError(err.message);
      }
    });
  }

  if (orgSelect) {
    orgSelect.addEventListener("change", async (e) => {
      await switchOrganization(e.target.value);
    });
    loadOrganizations();
  }

  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape") closeTransactionQuickView();
  });

  setSalesMode("monthly");
  showDashboard();
});

window.SALES_MODE = window.SALES_MODE || "monthly";
window.authorize = authorize;
window.checkHealth = checkHealth;
window.fyEndDateFromYear = fyEndDateFromYear;
window.loadOrganizations = loadOrganizations;
window.logoutSession = logoutSession;
window.setSalesMode = setSalesMode;
window.switchOrganization = switchOrganization;
