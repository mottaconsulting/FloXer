# app.py Structure Map

`backend/app.py` is a single monolithic file (~3,600 lines) that contains the entire backend. This document maps its sections so you can navigate without scrolling.

---

## Section Overview

| Lines | Section | What it contains |
|---|---|---|
| 1–100 | Imports & App Init | Dependencies, env loading, Flask app creation, CSP/CORS config |
| 100–170 | Config | Xero credentials, Supabase URLs, rate limit constants, Flask session config |
| 173–247 | Middleware | Rate limiting, CSRF protection, security headers |
| 249–609 | DB & Token Helpers | Supabase connection, Xero token storage/loading/refresh |
| 610–882 | Data Loading Helpers | DataFrame normalization, sign convention, budget/actuals loading from Xero + Supabase |
| 883–1182 | Date & Schedule Utilities | FY bounds, quarter bounds, liability schedule building, ATO due date rules |
| 1183–1924 | Core Financial Logic | Cash projection, tax installment projection, accrual estimation, forecast payload builder |
| 1926–2490 | `build_overview_payload()` | Assembles the full `/api/dashboard/overview` response |
| 2491–2652 | `build_liabilities_payload()` | Assembles the `/api/dashboard/liabilities` response |
| 2653–2680 | Debug Routes | `/api/debug/config`, `/api/debug/balance-sheet` |
| 2682–2893 | Auth Routes | Xero OAuth, logout, connections, tenant selection |
| 2895–3075 | Page Routes | `/`, `/login`, `/signup`, `/dashboard`, `/health` |
| 3077–3175 | Core API Routes | Invoices, contacts, accounts, journals, budget (GET+POST) |
| 3175–3590 | Dashboard API Routes | All `/api/dashboard/*` endpoints |

---

## Section Details

### Imports & App Init (1–100)

Standard library and third-party imports. Flask app is created with the frontend directory as its static folder — this is why the frontend is served by Flask on the same origin (no separate static host).

CSP headers are assembled at startup from env vars (`CSP_EXTRA_*`). This means adding a new CDN requires a deploy, not just a code change.

### Config (100–170)

All `os.getenv()` calls for Xero, Supabase, and rate limiting live here. The app raises `RuntimeError` at startup if required vars are missing — this is intentional so misconfiguration fails fast rather than silently.

Rate limit defaults: 120 requests per 60-second window per IP.

### Middleware (173–247)

Three hooks run on every request:

- `enforce_rate_limit()` — sliding window counter per client IP, returns 429 if exceeded
- `csrf_protect_forms()` — validates `_csrf_token` on form POST/PUT/PATCH/DELETE
- `add_secure_headers()` — attaches CSP, X-Frame-Options, X-Content-Type-Options

### DB & Token Helpers (249–609)

All Supabase and Xero token management lives here. Key functions:

| Function | Purpose |
|---|---|
| `_supabase_conn()` | Context manager returning a psycopg2 connection |
| `load_tokens()` | Loads current user's Xero tokens from Supabase |
| `save_tokens()` | Saves tokens to Supabase |
| `get_access_token()` | Returns a valid access token, refreshing if expired |
| `refresh_access_token()` | Calls Xero token endpoint, saves new tokens |
| `require_tenant_id()` | Returns tenant_id from session, fetches from Xero if missing |
| `xero_headers()` | Returns auth headers dict for Xero API calls |

**Important**: Xero may rotate the `refresh_token` on each call. `refresh_access_token()` always saves the newest token — never hold a reference to an old refresh token.

### Data Loading Helpers (610–882)

Handles fetching raw data and normalizing it into DataFrames:

| Function | Purpose |
|---|---|
| `_normalize_schema()` | Normalizes column names from Xero journal CSVs |
| `_enforce_sign_convention()` | Ensures revenue=negative, expense=positive NET_AMOUNT |
| `_load_actuals_df_xero()` | Loads journal lines from Xero for the current FY |
| `_load_budget_df_supabase()` | Loads budget rows for current user from Supabase |
| `_load_budget_df_active()` | Returns actuals or budget depending on what's available |
| `_load_liability_lines_df_xero()` | Loads liability-related journal lines from Xero |
| `_load_live_bank_balance_xero()` | Fetches current bank balance from Xero Balance Sheet |

**Sign convention**: Revenue rows have negative `NET_AMOUNT` (Xero double-entry convention). Expense rows are positive. The helper `_enforce_sign_convention()` corrects any rows that violate this. When you see `revenue = -sum(revenue_rows)`, the sign flip is intentional.

### Date & Schedule Utilities (883–1182)

Pure calculation functions with no external calls:

| Function | Purpose |
|---|---|
| `_fy_bounds()` | Start and end dates of the current financial year |
| `_month_range()` | List of month-start dates within a FY |
| `_fy_quarter_bounds()` | Start/end of the quarter containing a given date |
| `_build_liability_schedule()` | Builds the per-obligation due date schedule from journal lines |
| `_is_trade_creditor()` | Filter: is this a trade creditor (excluded from obligations)? |
| `_liability_type()` | Classifies account as GST / PAYG / SUPER / other |
| `_liability_frequency_config()` | Determines monthly vs quarterly cycle from env + data |
| `_ato_bas_due()` | Due date for BAS (21 days after quarter end) |
| `_ato_super_due()` | Due date for super |
| `_expected_due_date()` | Due date dispatcher — routes by liability type to the correct rule |

To change a due date rule, edit `_expected_due_date()`. Frequency detection reads from env vars `GST_FREQUENCY`, `PAYG_FREQUENCY`, `SUPER_FREQUENCY` (default: quarterly).

### Core Financial Logic (1183–1924)

The engine. These functions produce the numbers shown on the dashboard:

| Function | Purpose |
|---|---|
| `complete_budget_to_fy()` | Extends partial budget data to cover the full FY |
| `_calc_revenue_expense()` | Sums revenue and expenses from a DataFrame |
| `_monthly_series()` | Builds month-by-month revenue or expense arrays |
| `_fetch_pl_report()` | Fetches Profit & Loss from Xero Reports API |
| `_fetch_balance_sheet()` | Fetches Balance Sheet from Xero Reports API |
| `_fetch_balance_sheet_liabilities()` | Extracts liability totals from Balance Sheet |
| `_fetch_outstanding_bills()` | Fetches unpaid bills from Xero |
| `_build_cash_projection_rows()` | **Core**: builds month-by-month forward cash projection |
| `_build_out_of_cash_summary()` | Calculates out-of-cash date from projection rows |
| `_project_future_tax_installments()` | Projects upcoming GST/PAYG/Super obligations |
| `_estimate_upcoming_accruals()` | Estimates obligations not yet on Balance Sheet |
| `build_forecast_payload()` | Assembles the forecast sub-section of the overview payload |

**`_build_cash_projection_rows()` is the most important function in the file.** It produces the month-by-month forecast that drives the "out of cash" date and the cash timeline chart. The frontend mirrors a simplified version of this logic in `buildCashTimeline()` for the bank balance override case.

### `build_overview_payload()` (1926–2490)

The central function. Called by `GET /api/dashboard/overview`. Assembles data from all sources into a single response:

```
Xero (journals, balance sheet, P&L, invoices)
+ Supabase (budget rows)
→ build_overview_payload()
→ { meta, kpis, obligations, projection, charts }
```

To add a new number to the dashboard, add it to the appropriate section here, then read it in the relevant frontend module.

### `build_liabilities_payload()` (2491–2652)

Called by `GET /api/dashboard/liabilities`. Returns a detailed breakdown of tax obligations and their due dates. Distinct from the obligations summary embedded in the overview payload.

### Debug Routes (2653–2680)

Two debug-only endpoints:

- `GET /api/debug/config` — shows which env vars are set and connection status. Use this first when diagnosing a broken deployment.
- `GET /api/debug/balance-sheet` — returns raw Xero Balance Sheet JSON. Use to diagnose bank balance or liability issues.

These are not protected by authentication — suitable for local debugging, but do not expose in a public deployment.

### Auth Routes (2682–2893)

| Route | Purpose |
|---|---|
| `GET /auth/start` | Builds Xero authorization URL, redirects to Xero login |
| `GET /callback` | Receives OAuth code, exchanges for tokens, stores in Supabase |
| `GET /auth/logout` | Clears Flask session |
| `GET /connections` | Lists connected Xero organisations, lets user switch |
| `GET /set-tenant` | Sets active tenant_id in session |

The OAuth flow is: `/auth/start` → Xero login → `/callback` → tokens saved → `/dashboard`.

### Page Routes (2895–3075)

Serve HTML pages:

| Route | Page |
|---|---|
| `GET /` | Redirects to `/dashboard` |
| `GET /login` + `POST /login` | Login page |
| `POST /login/forgot` | Password reset request |
| `GET /signup` + `POST /signup` | Registration |
| `GET /login/reset` + `POST /login/reset` | Password reset confirmation |
| `GET /dashboard` | Main app shell (requires login) |
| `GET /health` | Health check — returns `{ "status": "ok" }` |
| `GET /setup` | First-run setup page |

### Core API Routes (3077–3175)

| Route | Purpose |
|---|---|
| `GET /api/invoices` | Raw invoices from Xero |
| `GET /api/contacts` | Contacts from Xero |
| `GET /api/accounts` | Chart of accounts from Xero |
| `GET /api/journals` | Journal lines from Xero |
| `GET /api/journal-lines` | Journal lines (alias) |
| `POST /api/refresh` | Force-refresh Xero access token |
| `GET /api/liabilities` | Liabilities (alias for dashboard/liabilities) |
| `GET /api/budget` | Load budget rows for current user |
| `POST /api/budget` | Save budget rows for current user |

### Dashboard API Routes (3175–3590)

All `/api/dashboard/*` endpoints. Most are thin wrappers around the payload builders:

| Route | What it returns |
|---|---|
| `GET /api/dashboard/overview` | Main dashboard payload — use this for most things |
| `GET /api/dashboard/liabilities` | Detailed liabilities breakdown |
| `GET /api/dashboard/forecast` | Forward cash forecast |
| `GET /api/dashboard/summary` | Simplified summary (subset of overview) |
| `GET /api/dashboard/sales-by-month` | Monthly sales data |
| `GET /api/dashboard/top-customers` | Top customers by revenue |
| `GET /api/dashboard/sales-by-status` | Invoice revenue grouped by status |
| `GET /api/dashboard/invoice-count-by-status` | Invoice counts by status |
| `GET /api/dashboard/budget-monthly` | Monthly budget vs actuals |
| `GET /api/dashboard/budget-chart` | Budget chart data |
| `GET /api/dashboard/profit-chart` | Profit chart data |

---

## Finding Something Quickly

**"Where does the bank balance come from?"**
→ `_load_live_bank_balance_xero()` (~line 553), called inside `build_overview_payload()`

**"Where is the out-of-cash date calculated?"**
→ `_build_out_of_cash_summary()` (~line 1602), called from `build_overview_payload()`

**"Where is GST due date set?"**
→ `_ato_bas_due()` (~line 1128) + `_expected_due_date()` (~line 1146)

**"Where does budget data come from?"**
→ `_load_budget_df_supabase()` (~line 758), called via `_load_budget_df_active()`

**"Where is the Xero P&L fetched?"**
→ `_fetch_pl_report()` (~line 1256)

**"Where is the cash projection for the chart built?"**
→ `_build_cash_projection_rows()` (~line 1546)
