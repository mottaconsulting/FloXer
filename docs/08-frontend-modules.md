# Frontend Modules

The frontend is vanilla JavaScript — no build step, no framework, no bundler.
Files are loaded via `<script>` tags in `frontend/index.html`.

Because there is no module system, all functions and variables are **global**. The load order of the script tags matters.

---

## Load Order (from index.html)

Files are loaded in this order, which defines their dependency chain:

1. `formatters.js` — pure utilities, no dependencies
2. `tables.js` — Xero date/currency parsing
3. `cache.js` — global state and cache management
4. `api.js` — fetch wrapper
5. `liabilities.js` — liability classification helpers
6. `kpi.js` — KPI computation and DOM rendering
7. `ui.js` — modal, org select, raw data toggle
8. `health.js` — health strip rendering
9. `charts.js` — Chart.js wrappers
10. `main.js` — overview fetch, chart rendering, FY select
11. `init.js` — session bootstrap, logout, auth popup
12. `features/dashboard.js` — dashboard card rendering
13. `features/cash-timeline.js` — cash timeline rendering
14. `features/transactions.js` — transactions page
15. `features/budget.js` — budget input page

---

## Module Responsibilities

### formatters.js

Pure formatting utilities. No DOM, no state, no API calls.

Key functions:
- `fmtCurrency(n)` — formats a number as currency using `APP_CURRENCY`
- `setAppCurrency(code)` — sets the global `APP_CURRENCY` variable
- `formatDelta(v, asCurrency)` — formats a delta value with +/- sign
- `round2(x)` — rounds to 2 decimal places

### tables.js

Xero-specific date and currency parsing. Exposed as the `XeroTables` global.

Key functions:
- `XeroTables.parseXeroDate(dateString)` — handles Xero's `/Date(timestamp+offset)/` format
- `XeroTables.formatDate(dateString)` — formats a Xero date for display
- `XeroTables.formatCurrency(amount)` — formats currency

### cache.js

All global mutable state lives here. If you need to understand what is cached between API calls, read this file.

Key globals:
- `JOURNAL_CACHE` — raw journals from `/api/journals`, cleared on page load
- `JOURNAL_LINES` — flattened journal lines, derived from `JOURNAL_CACHE`
- `OVERVIEW_CACHE` — Map keyed by request params, TTL 3 minutes
- `BUDGET_CACHE` — budget rows, TTL 3 minutes
- `APP_CURRENCY` — active currency code (default `"AUD"`)
- `BALANCE_ADJUST_EVENTS_BOUND` — prevents duplicate event binding

### api.js

Fetch wrapper. Exposed as the `XeroAPI` global.

Key functions:
- `XeroAPI.fetch_json(path, options)` — `GET` with credentials and `Accept: application/json`
- `XeroAPI.open_auth_popup()` — opens the Xero OAuth popup window

All fetch calls go through this. It handles:
- Sending session cookies (`credentials: "include"`)
- Detecting `401` responses and redirecting to `/login`
- Detecting Xero "not connected" responses and showing the connect modal

### liabilities.js

Liability classification logic — mirrors some of the backend's liability rules in the frontend.
Used by `health.js` to classify liability rows returned by `/api/dashboard/liabilities`.

Key globals:
- `LIABILITY_RULES` — object mapping liability type (`GST`, `PAYG`, `SUPER`, etc.) to frequency and due-date rules

Key functions:
- `classifyLiabilityAccount(code, name)` — returns liability type string

### kpi.js

KPI computation helpers and DOM rendering. Depends on `formatters.js` and `cache.js`.

Key functions:
- `setKpiValue(valueEl, metaEl, value, options)` — renders a KPI value into a DOM element
- `setDelta(el, value)` — renders a delta/change value with up/down styling
- `parseCurrencyInput(value)` — parses user-typed currency strings (strips `$`, commas)
- `finiteNumberOrNaN(value)` — safe number parsing
- `getBalanceOverrideStorageKey(data)` — generates localStorage key for the bank balance override, scoped per org and FY
- `computeBalanceKpi(data)` — computes the effective bank balance, applying any manual override
- `setBalanceOverrideValue(data, value)` — saves a manual bank balance to localStorage

**The bank balance override lives in localStorage, keyed by org ID and FY end year.**
When a user edits the bank balance, it is stored in `localStorage` and applied on every subsequent render — not sent to the backend.

### ui.js

UI chrome — org selector, raw data debug toggle, Xero connect modal. Exposed as the `XeroUI` global.

Key functions:
- `XeroUI.getRawData()` — returns the last fetched overview payload (used by other modules to re-render on state change)
- `ensureXeroConnectModalLoaded()` — lazy-loads the connect modal HTML from `/partials/xero-connect-modal.html`
- `showXeroConnectModal()` / `hideXeroConnectModal()` — modal visibility

### health.js

Renders the health strip at the top of the dashboard (runway, burn rate, cash status).

Key functions:
- `computeHealthFromModel(model, liabilitiesRows)` — derives health signal from the overview payload
- `renderHealthStrip(model, liabilitiesRows)` — renders the strip into the DOM

### charts.js

Chart.js wrappers. All chart instances are stored in the `charts` global object.

Custom plugin: `monthHighlightPlugin` — draws a shaded background region on charts to separate actual months from projected months.

Key functions:
- `renderSalesChart(data)` — revenue & expenses chart
- `renderProfitChart(data)` — profit YTD chart
- `renderCashflowChart(data)` — cash in / cash out chart

Charts are keyed by DOM element ID. Calling a render function a second time destroys and recreates the chart.

### main.js

Overview orchestration. Fetches `/api/dashboard/overview`, populates the FY/date selectors, and coordinates chart rendering.

Key functions:
- `loadOverview(params)` — fetches the overview payload (with caching), calls `renderOverview`
- `renderOverview(data)` — dispatches to all render functions: KPIs, charts, timeline, health
- `populateFySelect(data)` — fills the financial year dropdown from `meta.available_fy_end_years`
- `populateDateSelect(data)` — fills the month dropdown from `meta.available_months`
- `selectedOverviewToday()` — reads the current FY selector and returns the FY end date

**Entry point for the dashboard page.** `init.js` calls `loadOverview()` after session bootstrap.

### init.js

Session bootstrap — runs on page load.

Responsibilities:
- Checks if user is logged in (via session cookie / redirect from Flask)
- Calls `loadOverview()` to start the dashboard
- Handles logout, `authorize()` (Xero OAuth popup), and `restartDashboard()`
- Watches for OAuth popup close and triggers a reload after successful Xero connect

Key functions:
- `logoutSession()` — calls `/auth/logout`, redirects to `/login`
- `authorize()` — opens Xero OAuth popup, polls for close, reloads dashboard
- `restartDashboard()` — hard reload of `/dashboard`

### features/dashboard.js

Dashboard card rendering. Reads from the overview payload and writes to DOM elements.

Key functions:
- `renderDashboardCards(data)` — renders Profit YTD, Bank Balance, Out of Cash cards
- `renderDashboardRecentTransactions()` — renders the recent transactions table
- `bindBalanceAdjustEvents()` — wires up the bank balance edit button (called once on load)

**Bank balance edit flow:**
1. User clicks edit button
2. `window.prompt()` asks for a new value
3. Value saved to localStorage via `setBalanceOverrideValue()`
4. `renderOverview(data)` re-renders everything from the stored override

### features/cash-timeline.js

Cash timeline page rendering. This module is the active source of truth for the forward cash walk when a manual bank balance override is in effect.

Key functions:
- `buildCashTimeline(data, startingBalance)` — builds the month-by-month projection array from `projection.forecast_operating` and `obligations`
- `renderCashTimeline(data, startingBalance, isPastFy)` — renders the timeline table into the DOM
- `renderTimelineSummaryStrip(data, startingBalance)` — renders the summary strip (Starting Point, Lowest Point, etc.)

**Why this module owns projection math:**
The backend computes `closing_cash` per month, but if the user has edited the bank balance locally, that backend value is stale. The frontend rebuilds the walk from scratch using `startingBalance` (which includes the override) + the backend's `operating_revenue`, `operating_expenses`, and `obligations`. See [Financial Model](./01-financial-model.md) for the formula.

### features/transactions.js

Transactions page. Fetches journals via `/api/journals`, flattens them, and renders a paginated, filterable table.

Key functions:
- `getJournals()` — fetches and caches journal data
- `flattenJournalLines(journals)` — converts Xero journal format to flat row array
- `renderTransactionsTable(lines)` — renders paginated table

### features/budget.js

Budget input page. Reads from and writes to `/api/budget`.

Key functions:
- `loadBudget()` — fetches budget rows, renders the table
- `saveBudget()` — collects all rows from the DOM and `POST`s to `/api/budget`
- `renderBudgetRows(rows)` — renders budget rows into the editable table
- `applyBudgetUiState(data)` — updates the backend badge and meta text

---

## Global State Reference

| Variable | Module | Description |
|---|---|---|
| `APP_CURRENCY` | cache.js | Currency code, set from `meta.currency` on first load |
| `JOURNAL_CACHE` | cache.js | Raw journals array |
| `JOURNAL_LINES` | cache.js | Flattened journal lines |
| `OVERVIEW_CACHE` | cache.js | Map of overview payloads, keyed by params |
| `BUDGET_CACHE` | cache.js | Budget rows |
| `charts` | charts.js | Chart.js instances keyed by DOM ID |
| `_xeroUiCurrentData` | ui.js | Last rendered overview payload |
| `LIABILITY_RULES` | liabilities.js | Liability classification rules |

---

## How a Dashboard Page Load Works

1. `init.js` runs — detects session, calls `loadOverview()`
2. `loadOverview()` (main.js) — calls `GET /api/dashboard/overview`, stores result in `OVERVIEW_CACHE`
3. `renderOverview(data)` (main.js) — calls all render functions:
   - `populateFySelect(data)` — fills FY dropdown
   - `renderDashboardCards(data)` — Profit YTD, Bank Balance, Out of Cash (dashboard.js)
   - `renderHealthStrip(...)` — health strip (health.js)
   - `renderSalesChart(data)` — charts (charts.js)
   - `renderCashTimeline(data, startingBalance)` — cash walk (cash-timeline.js)
4. If a bank balance override exists in localStorage, `computeBalanceKpi()` applies it before rendering

---

## How to Add a New KPI Card

1. Add the value to the overview payload in `build_overview_payload()` in `backend/app.py` (under `kpis` or a new key)
2. Add the HTML card to `frontend/index.html`
3. In `features/dashboard.js`, read the value from `data.kpis.your_new_key` and call `setKpiValue()` to render it

## How to Add a New Chart

1. Add chart data to the `charts` section of the overview payload in `backend/app.py`
2. Add a canvas element to `frontend/index.html`
3. In `charts.js`, add a new render function following the pattern of existing chart functions
4. Call your render function from `renderOverview()` in `main.js`

## How to Change a Tax Calculation

Tax obligation logic lives in `backend/app.py` in these functions:
- `_build_liability_schedule()` — builds the obligation schedule from journal lines
- `_project_future_tax_installments()` — projects future cycles
- `_estimate_upcoming_accruals()` — estimates accruals not yet on Balance Sheet
- `_split_schedule_by_current_month()` — splits into committed (this month) vs future

Due date rules per liability type are in `_expected_due_date()`.
