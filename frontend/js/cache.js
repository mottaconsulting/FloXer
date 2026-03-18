// Global state
let JOURNAL_CACHE = null;
let JOURNAL_LINES = null;
let FILTERED_JOURNAL_LINES = null;
let TX_CURRENT_PAGE = 1;
let TX_PAGE_SIZE = 50;
let TX_FILTER_EVENTS_BOUND = false;
let APP_CURRENCY = "AUD";
let BALANCE_ADJUST_EVENTS_BOUND = false;
let OVERVIEW_CACHE = new Map();
let BUDGET_CACHE = null;
let BUDGET_CACHE_AT = 0;

const OVERVIEW_CACHE_TTL_MS = 180000;
const BUDGET_CACHE_TTL_MS = 180000;

const INCOME_TYPES = new Set(["REVENUE"]);
const EXPENSE_TYPES = new Set(["EXPENSE"]);
const BANK_TYPES = new Set(["BANK"]);

function buildOverviewQueryString(todayStr, fyStartMonth = 7, cashBalance = null, burnMonths = null) {
  const params = new URLSearchParams();
  if (todayStr) params.set("today", todayStr);
  if (fyStartMonth) params.set("fy_start_month", String(fyStartMonth));
  if (cashBalance !== null && cashBalance !== "" && Number.isFinite(Number(cashBalance))) {
    params.set("cash_balance", String(cashBalance));
  }
  if (burnMonths !== null && burnMonths !== "" && Number.isFinite(Number(burnMonths))) {
    params.set("burn_months", String(burnMonths));
  }
  const qs = params.toString();
  return qs ? `?${qs}` : "";
}

function getCachedOverview(qs = "") {
  const entry = OVERVIEW_CACHE.get(qs || "");
  if (!entry) return null;
  if ((Date.now() - entry.cachedAt) > OVERVIEW_CACHE_TTL_MS) {
    OVERVIEW_CACHE.delete(qs || "");
    return null;
  }
  return entry.data;
}

function getCachedOverviewEntry(qs = "") {
  const entry = OVERVIEW_CACHE.get(qs || "");
  if (!entry) return null;
  if ((Date.now() - entry.cachedAt) > OVERVIEW_CACHE_TTL_MS) {
    OVERVIEW_CACHE.delete(qs || "");
    return null;
  }
  return entry;
}

function setCachedOverview(qs = "", data) {
  OVERVIEW_CACHE.set(qs || "", { data, cachedAt: Date.now() });
}

function clearOverviewCache() {
  OVERVIEW_CACHE.clear();
}

function getCachedBudget() {
  if (!BUDGET_CACHE) return null;
  if ((Date.now() - BUDGET_CACHE_AT) > BUDGET_CACHE_TTL_MS) {
    BUDGET_CACHE = null;
    BUDGET_CACHE_AT = 0;
    return null;
  }
  return BUDGET_CACHE;
}

function setCachedBudget(data) {
  BUDGET_CACHE = data;
  BUDGET_CACHE_AT = Date.now();
}

function clearBudgetCache() {
  BUDGET_CACHE = null;
  BUDGET_CACHE_AT = 0;
}

window.clearBudgetCache = clearBudgetCache;
window.clearOverviewCache = clearOverviewCache;
