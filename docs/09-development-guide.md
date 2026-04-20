# Development Guide

This guide covers everything you need to work on FloXer day-to-day: running the app, making changes, debugging, and understanding where things live.

---

## Running Locally

### Start the backend

```bash
source venv/bin/activate      # or venv\Scripts\activate on Windows
python backend/app.py
```

Open `http://localhost:5000`.

The Flask development server auto-reloads when you save a Python file. You will see the reload in the terminal.

### Frontend changes

No build step. Edit any JS or HTML file and refresh the browser. There is no hot reload for the frontend — just a manual refresh.

### Logs

- **Local**: all Flask logs print directly to the terminal where you ran `python backend/app.py`
- **Production (Render)**: go to your Render service → **Logs** tab

---

## Development Without Xero

If you do not have a Xero account connected, most `/api/dashboard/*` endpoints will return errors because they require a valid Xero access token. The app is not currently set up with mock data.

**Workaround**: use the Xero demo company.

1. Go to [go.xero.com](https://go.xero.com)
2. Log in and switch to the **Xero Demo Company** (available in all Xero accounts under the org switcher)
3. Complete the OAuth flow in the app — the demo company works exactly like a real org

The demo company has pre-populated invoices, journals, and a chart of accounts, so the dashboard will render with real-looking data.

---

## Where Things Live

### To change a dashboard number

The data flow is:

```
Xero API → backend/app.py → /api/dashboard/overview → frontend JS → DOM
```

1. The backend fetches and computes in `build_overview_payload()` (around line 2025 in `app.py`)
2. The result is returned as JSON under `kpis`, `obligations`, `projection`, or `charts`
3. `features/dashboard.js` reads from `data.kpis.*` and renders cards
4. `features/cash-timeline.js` reads from `data.projection.*` and `data.obligations.*`

If a number looks wrong:
- Call `/api/dashboard/overview` directly in your browser to inspect the raw JSON
- Compare what the backend returns vs what the frontend renders

### To change the cash projection logic

- **Backend calculation**: `_build_cash_projection_rows()` in `app.py`
- **Frontend re-calculation** (authoritative after a bank balance edit): `buildCashTimeline()` in `frontend/js/features/cash-timeline.js`

Both must be kept in sync if you change the projection formula. See [Architecture](./04-architecture.md) for why both exist.

### To change tax/liability calculations

All tax logic is in `backend/app.py`:

| Function | Purpose |
|---|---|
| `_build_liability_schedule()` | Builds obligation schedule from journal lines |
| `_project_future_tax_installments()` | Projects future tax cycles |
| `_estimate_upcoming_accruals()` | Estimates accruals not yet on Balance Sheet |
| `_expected_due_date()` | Due date rules per liability type |
| `_liability_type()` | Classifies an account as GST / PAYG / SUPER / etc. |

Due date rules (e.g. GST due 21 days after period end) live inside `_expected_due_date()`.
Frequency detection (monthly vs quarterly) uses env vars `GST_FREQUENCY`, `PAYG_FREQUENCY`, `SUPER_FREQUENCY`.

### To change the budget

The budget is stored in Supabase `budget_rows`. Users edit it via the Budget page (`/dashboard#budget`).

- Budget input UI: `frontend/js/features/budget.js`
- Budget API: `GET /api/budget` and `POST /api/budget` in `app.py`
- Budget is loaded into the overview calculation via `_load_budget_df_active()` in `app.py`

### To change the Xero OAuth flow

The OAuth flow is in `app.py`:
- `/auth/start` — builds the authorization URL and redirects
- `/callback` — exchanges the code for tokens, stores in Supabase
- `refresh_access_token()` — refreshes expired tokens
- `load_tokens()` / `save_tokens()` — read/write to Supabase `xero_tokens`

### To change a chart

Charts use Chart.js loaded via CDN in `index.html`.
- Chart rendering functions are in `frontend/js/charts.js`
- Chart data comes from `data.charts.*` in the overview payload
- The `monthHighlightPlugin` in `charts.js` draws the actual/forecast split line

---

## Common Errors and How to Fix Them

### "SUPABASE_URL and SUPABASE_ANON_KEY must be set"

The app crashes at startup because Supabase env vars are missing.

Fix: check your `.env.local` has `SUPABASE_URL` and `SUPABASE_ANON_KEY` set correctly.

### "SUPABASE_DB_URL must be set"

Same issue for the database connection string.

Fix: check `SUPABASE_DB_URL` is set and uses the **pooler** connection string from Supabase (not the direct connection). See [Setup and Deployment](./06-setup-and-deployment.md#23-get-the-database-connection-string).

### 401 on API calls / redirected to /login

The Flask session has expired or was never set.

Fix: log in again at `/login`. If you just signed up, make sure you confirmed your email.

### "No stored token for this session user/tenant"

The user is logged in to the app but has not connected Xero, or the Xero token was deleted.

Fix: go to `/auth/start` to reconnect Xero.

### "No tenant selected"

Xero is connected but no organisation has been selected.

Fix: go to `/connections` to choose an organisation.

### Dashboard shows all zeros or "--"

Usually means the Xero connection is not active or the selected FY has no data.

Check:
1. Visit `/api/debug/config` to confirm Xero is connected
2. Visit `/api/journals` to see if journals are returning
3. Check the FY selector — the selected year may have no actuals

### Xero OAuth redirect_uri mismatch

Xero returns an error during OAuth with a "redirect_uri mismatch" message.

Fix: `XERO_REDIRECT_URI` in your env must match **exactly** one of the URIs registered in the Xero developer portal. Check for trailing slashes, `http` vs `https`, or mismatched domain.

### Budget rows not saving

Check:
1. The `budget_rows` table exists in Supabase (see [Setup](./06-setup-and-deployment.md#25-create-the-required-database-tables))
2. The user is logged in (budget is user-scoped)
3. Check browser console and Render logs for the specific error

### Charts not rendering

Chart.js is loaded from CDN. If the CDN is blocked or fails, charts will be blank.

Check the browser console for `Chart is not defined`. If that appears, the CDN script tag in `index.html` failed to load.

---

## Inspecting the API Directly

You can call any API endpoint directly in the browser or with `curl` while logged in locally.

Useful endpoints for debugging:

```
GET http://localhost:5000/api/debug/config
```
Confirms which env vars are set and what mode the app is in.

```
GET http://localhost:5000/api/debug/balance-sheet
```
Returns the raw Xero Balance Sheet. Use this to diagnose bank balance or liability issues.

```
GET http://localhost:5000/api/dashboard/overview
```
The full overview payload. Inspect `kpis`, `obligations`, and `projection` directly.

```
GET http://localhost:5000/api/journals
```
Raw journals from Xero. If this is empty, the dashboard will have no data.

```
GET http://localhost:5000/health
```
Health check. Should return `{ "status": "ok" }`.

---

## Making a Change — End to End Example

**Goal: add a new KPI showing total overdue invoices.**

1. **Backend** — add a calculation in `build_overview_payload()` in `app.py`:
   ```python
   overdue_invoices = _calculate_overdue_total(actuals_fy)
   # add to the kpis dict in the payload:
   "overdue_invoices": round(float(overdue_invoices), 2),
   ```

2. **Test the endpoint** — run the app, visit `/api/dashboard/overview`, confirm `kpis.overdue_invoices` appears in the JSON.

3. **Frontend HTML** — add a card in `frontend/index.html`:
   ```html
   <div class="kpi-card">
     <div class="kpi-label">Overdue Invoices</div>
     <div class="kpi-value" id="kpiOverdueInvoices">--</div>
   </div>
   ```

4. **Frontend JS** — in `features/dashboard.js`, inside `renderDashboardCards(data)`:
   ```js
   setKpiValue(
     document.getElementById("kpiOverdueInvoices"),
     null,
     data?.kpis?.overdue_invoices
   );
   ```

5. **Refresh the browser** — the new card should render.

---

## Deployment Workflow

1. Make and test changes locally
2. Commit:
   ```bash
   git add -p                    # stage specific changes
   git commit -m "describe change"
   git push origin main
   ```
3. Render auto-deploys on push to `main`. Watch the **Logs** tab in Render for build and startup errors.

If a deploy breaks the app:
- Go to Render → **Deploys** → click the last working deploy → **Rollback to this deploy**

---

## Things to Know Before Changing the Code

### Sign convention for money

FloXer follows Xero's double-entry sign convention:
- **Revenue** rows have **negative** `NET_AMOUNT` (credit)
- **Expense** rows have **positive** `NET_AMOUNT` (debit)
- **Bank** rows: positive = cash received, negative = cash paid out

This means when you see `revenue_value = -sum(revenue_rows)` in the code, that is intentional — flipping the sign to make revenue positive for display.

### The frontend rebuilds the cash walk

After a manual bank balance edit, the frontend does not re-fetch from the backend. It rebuilds the full month-by-month projection locally in `buildCashTimeline()` using the backend's operating rows + the local bank balance override. This means:

- `projection.forecast_operating[n].closing_cash` in the API response may differ from what the frontend displays
- The frontend value is correct (it includes the override)
- This is intentional — see [Known Limitations](./05-known-limitations.md)

### Budget sign convention

Budget rows stored in Supabase use the same sign convention as Xero journal lines:
- Revenue budget rows: `NET_AMOUNT` is negative
- Expense budget rows: `NET_AMOUNT` is positive

The budget input UI (`features/budget.js`) handles this conversion — users enter positive numbers, the save function applies the correct sign before sending to the API.

### Caching

The overview payload is cached in `OVERVIEW_CACHE` (in-memory, browser-side) for 3 minutes. If you are testing a backend change and the dashboard is not updating, either wait 3 minutes or do a hard refresh (`Ctrl+Shift+R`).

Budget data has a separate 3-minute cache (`BUDGET_CACHE`).
