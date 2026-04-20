# API Reference

All endpoints require an authenticated session (user must be logged in via Supabase).
Requests without a valid session return `401` or redirect to `/login`.

All responses are JSON. All currency values are floats in AUD (or the organisation's currency).

---

## Auth & Session

### GET /auth/start
Initiates Xero OAuth2 flow. Redirects the browser to Xero's login page.

Requires: user session. Redirects to Xero — not called via fetch.

### GET /callback
OAuth2 callback from Xero. Stores access/refresh tokens in Supabase `xero_tokens`. Redirects to `/connections`.

### GET /connections
Lists connected Xero organisations for the current user. Returns HTML page.

### POST /set-tenant
Selects which Xero organisation to use for the session.

Body: `{ "tenant_id": "xxxx-xxxx" }`

### GET /auth/logout
Clears session and Supabase tokens. Redirects to `/login`.

### GET /api/refresh
Forces a Xero token refresh. Returns:
```json
{ "ok": true, "tenant_id": "...", "expires_at": 1234567890 }
```

---

## Main Dashboard Endpoint

### GET /api/dashboard/overview

The primary endpoint. Returns everything the dashboard and cash timeline need in one payload.

**Query parameters:**

| Parameter | Type | Default | Description |
|---|---|---|---|
| `today` | ISO date string | server today | Override the reference date (e.g. `2025-06-30`) |
| `fy_start_month` | int | `7` | Financial year start month (7 = July for AU) |
| `cash_balance` | float | Xero live balance | Manual bank balance override |
| `burn_months` | int | `3` | How many trailing months to use for burn rate average |

**Response shape:**

```json
{
  "meta": {
    "today": "2025-04-15",
    "requested_today": "2025-04-15",
    "as_of_month": "2025-04",
    "fy_start": "2024-07-01",
    "fy_end": "2025-06-30",
    "currency": "AUD",
    "available_months": ["2024-07", "2024-08", "..."],
    "available_fy_end_years": [2024, 2025],
    "balance_sheet_source": "xero_report"
  },
  "kpis": {
    "profit_now": 45000.00,
    "profit_now_prev": 38000.00,
    "future_profit": 12000.00,
    "gross_cash_today": 85000.00,
    "committed_cash_today": 12000.00,
    "free_cash_today": 73000.00,
    "cash_balance_live": 85000.00,
    "cash_balance_source": "balance_sheet",
    "runway_months": 4.2,
    "monthly_burn": 20000.00,
    "sales_this_month": 30000.00,
    "spending_this_month": 18000.00,
    "warnings": []
  },
  "obligations": {
    "committed_this_month": [
      { "name": "GST", "amount": 8000.00, "month": "2025-04", "type": "gst" }
    ],
    "future_known": [ ... ],
    "future_forecast": [ ... ],
    "summary": {
      "committed_this_month": 12000.00,
      "future_known": 24000.00,
      "future_forecast": 8000.00
    }
  },
  "projection": {
    "starting_cash": 73000.00,
    "forecast_operating": [
      {
        "month": "2025-05",
        "operating_revenue": 28000.00,
        "operating_expenses": 15000.00,
        "operating_net": 13000.00,
        "closing_cash": 86000.00
      }
    ],
    "out_of_cash": {
      "days_until_out_of_cash": 142,
      "out_of_cash_date": "2025-09-04",
      "state": "days",
      "starting_cash": 73000.00
    }
  },
  "charts": {
    "sales_fy": {
      "labels": ["2024-07", "2024-08", "..."],
      "actual_monthly": [ ... ],
      "projected_monthly": [ ... ]
    },
    "profit_fy": {
      "labels": [...],
      "actual_monthly_profit": [...],
      "projected_monthly_profit": [...]
    },
    "expenses_fy": {
      "labels": [...],
      "actual_monthly": [...],
      "projected_monthly": [...]
    },
    "cashflow": {
      "labels": [...],
      "cashIn": [...],
      "cashOut": [...]
    }
  }
}
```

**Key fields explained:**

- `kpis.free_cash_today` — this is `Starting Point`: bank balance minus committed tax this month
- `kpis.gross_cash_today` — raw bank balance from Xero (or Balance Sheet fallback)
- `kpis.cash_balance_source` — `"balance_sheet"`, `"xero"`, `"proxy"`, or `"unavailable"`
- `obligations.committed_this_month` — tax items due this month or overdue
- `projection.out_of_cash.state` — `"now"`, `"days"`, or `"positive_through_fy_end"`
- `charts.sales_fy.projected_monthly` — `null` for future months when no budget exists

---

## Liabilities

### GET /api/dashboard/liabilities
### GET /api/liabilities (alias)

Returns the current tax obligation schedule.

**Query parameters:**

| Parameter | Default | Description |
|---|---|---|
| `today` | server today | Reference date |
| `period` | `"month"` | `"month"` or `"quarter"` |
| `fy_start_month` | `7` | FY start month |
| `gst_frequency` | `"monthly"` | `"monthly"` or `"quarterly"` |
| `payg_frequency` | env default | `"monthly"` or `"quarterly"` |
| `super_frequency` | env default | `"monthly"` or `"quarterly"` |

**Response:**
```json
{
  "meta": {
    "today": "2025-04-15",
    "period": "month",
    "warnings": []
  },
  "rows": [
    {
      "account_code": "820",
      "account_name": "GST",
      "outstanding_owed": 8200.00,
      "expected_due_date": "2025-05-21",
      "days_to_due": 36,
      "status": "Not due",
      "basis_rule": "GST monthly — 21 days after period end"
    }
  ]
}
```

**Status values:** `"Not due"`, `"Due soon"` (within 14 days), `"Overdue"`, `"Paid"`, `"Credit/Overpaid"`

---

## Budget

### GET /api/budget

Returns the user's stored budget rows from Supabase.

```json
{
  "mode": "xero",
  "budget_backend": "supabase",
  "rows": [
    {
      "JOURNAL_DATE": "2025-05-01",
      "ACCOUNT_TYPE": "REVENUE",
      "ACCOUNT_NAME": "Sales",
      "ACCOUNT_CODE": "",
      "NET_AMOUNT": -30000.00,
      "DATA_CATEGORY": "Budget"
    }
  ]
}
```

> Note: Revenue rows have negative `NET_AMOUNT` following Xero's double-entry convention (credit = negative). The frontend and backend both handle this sign convention.

### POST /api/budget

Replaces all budget rows for the current user.

Body:
```json
{ "rows": [ { "JOURNAL_DATE": "2025-05-01", "ACCOUNT_TYPE": "REVENUE", "NET_AMOUNT": -30000 } ] }
```

Response: `{ "ok": true, "saved_rows": 12, "rows": [...] }`

---

## Charts & Supplementary Endpoints

### GET /api/dashboard/sales-by-month
Monthly revenue breakdown. Returns `{ "labels": [...], "data": [...] }`.

### GET /api/dashboard/top-customers
Top customers by revenue. Returns `{ "labels": [...], "data": [...] }`.

### GET /api/dashboard/sales-by-status
Invoice totals grouped by status (PAID, AUTHORISED, etc.).

### GET /api/dashboard/invoice-count-by-status
Count of invoices per status.

### GET /api/dashboard/budget-monthly
Monthly budget vs actuals comparison.

### GET /api/dashboard/budget-chart
Budget chart series data.

### GET /api/dashboard/profit-chart
Profit chart series. Query param: `fy_start_month`.

### GET /api/dashboard/forecast
Operating forecast series.

### GET /api/dashboard/summary
Lightweight summary payload (subset of `/overview`).

---

## Raw Xero Passthrough

These proxy directly to Xero's API. Useful for debugging.

| Endpoint | Xero resource |
|---|---|
| `GET /api/invoices` | Invoices |
| `GET /api/contacts` | Contacts |
| `GET /api/accounts` | Chart of Accounts |
| `GET /api/journals` | Journals |

---

## Health & Debug

### GET /health
Returns `{ "status": "ok" }`. Used by Render for uptime checks.

### GET /api/debug/config
Returns current configuration state (env vars set, mode, backend). Safe to call — returns no secrets.

### GET /api/debug/balance-sheet
Returns the raw balance sheet from Xero. Useful for diagnosing liability/bank balance issues.

---

## Error Format

All errors return:
```json
{ "error": "description of what went wrong" }
```

Common HTTP status codes:
- `401` — not logged in, or Xero token missing/expired
- `400` — bad request parameters
- `500` — backend error (check Render logs)
