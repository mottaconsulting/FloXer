# FloXer — Claude Code Context

FloXer is a Xero-connected cash flow forecasting app for small businesses. It pulls accounting data from Xero, combines it with manual budget inputs and tax obligations, and shows current performance, bank cash, and projected out-of-cash date.

## Tech Stack

| Layer | Technology |
|---|---|
| Backend | Python 3.11, Flask 3.0.3, Gunicorn |
| Frontend | Vanilla JS (no bundler), HTML5, CSS |
| Database / Auth | Supabase (PostgreSQL + Auth) |
| Accounting data | Xero API (OAuth2) |
| Deployment | Render |
| Charts | Chart.js (CDN) |

## Project Layout

```
FloXerAPP/
├── backend/app.py          # entire backend — one monolithic file (~3,600 lines)
├── frontend/
│   ├── index.html          # main app shell (includes inline scripts)
│   ├── login.html / signup.html / reset.html
│   └── js/
│       ├── api.js / cache.js / formatters.js / tables.js / ui.js
│       ├── kpi.js / charts.js / main.js
│       └── features/
│           ├── dashboard.js        # KPI cards
│           ├── cash-timeline.js    # forward cash projection (rebuilt locally on balance override)
│           ├── transactions.js
│           └── budget.js
├── docs/                   # 10 markdown docs — read these before making changes
├── .env.example            # all required env vars with explanations
└── render.yaml             # Render deployment config
```

## Key Architectural Facts

**The backend does one job**: fetch from Xero + Supabase, compute everything, return JSON. Do not add rendering logic here.

**The frontend does one job**: call `/api/dashboard/overview`, render cards, charts, and timeline. Do not add computation logic here — except the one intentional exception below.

**The one intentional exception — frontend re-projection**: After a user edits the bank balance manually, the frontend rebuilds the full cash timeline locally in `buildCashTimeline()` (`features/cash-timeline.js`) without hitting the backend. This means `/api/dashboard/overview` projection values and displayed values can legally diverge. This is documented in `docs/04-architecture.md` and `docs/05-known-limitations.md`. Do not "fix" this by adding a backend call — the override is intentionally not persisted.

**Sign convention** (Xero double-entry): Revenue rows have **negative** `NET_AMOUNT`; expense rows have **positive** `NET_AMOUNT`. When you see `revenue = -sum(revenue_rows)` in the code, that flip is intentional. See `docs/09-development-guide.md` — "Sign convention for money".

**Budget sign convention**: Budget rows in Supabase use the same sign as Xero journal lines (revenue negative, expense positive). The budget UI flips signs automatically — users enter positive numbers.

**Overview payload is the contract**: `/api/dashboard/overview` returns a large JSON object shaped as `{ meta, kpis, obligations, projection, charts }`. This is the primary data contract between backend and frontend. When adding a new number, add it to the correct section of this payload in `build_overview_payload()` (app.py ~line 2025).

## Environment Variables

All variables are documented in `.env.example`. Critical ones that block startup if missing:
- `FLASK_SECRET_KEY` — must be ≥32 chars
- `XERO_CLIENT_ID` / `XERO_CLIENT_SECRET`
- `SUPABASE_URL` / `SUPABASE_ANON_KEY` / `SUPABASE_DB_URL`

Frequency env vars (optional, default quarterly): `GST_FREQUENCY`, `PAYG_FREQUENCY`, `SUPER_FREQUENCY`

## Where to Make Common Changes

| Change | Where |
|---|---|
| New dashboard KPI | `build_overview_payload()` in app.py (~line 2025), then `features/dashboard.js` |
| Cash projection formula | `_build_cash_projection_rows()` app.py (~line 1546) AND `buildCashTimeline()` in cash-timeline.js (keep in sync) |
| Tax due date rules | `_expected_due_date()` app.py (~line 1146) |
| Tax frequency detection | `_liability_frequency_config()` app.py (~line 1069) |
| Budget save/load | `_load_budget_df_supabase()` / `_save_budget_rows_supabase()` app.py (~lines 758–833) |
| OAuth flow | `/auth/start`, `/callback`, `refresh_access_token()` app.py (~lines 2686–2820) |
| New chart | `charts.js`, add data to `charts` section in `build_overview_payload()` |

## Supabase Tables

| Table | Purpose |
|---|---|
| `xero_tokens` | Stores Xero OAuth tokens per user+tenant |
| `budget_rows` | User-entered monthly budget figures |
| users table | Managed by Supabase Auth (not custom) |

## Testing

There is no automated test suite. Manual testing workflow:
1. Run app locally: `python backend/app.py`
2. Call endpoints directly in browser or curl while logged in
3. Use `/api/debug/config` to verify env/connection state
4. Use `/api/debug/balance-sheet` to diagnose bank balance or liability issues
5. Use Xero Demo Company for realistic data without a live org

## Docs Index

| Doc | Read When |
|---|---|
| `docs/01-financial-model.md` | Changing any money calculation |
| `docs/02-product-overview.md` | Unsure if a feature belongs |
| `docs/03-dashboard-and-pages.md` | Understanding what each page/card shows |
| `docs/04-architecture.md` | Changing data flow between backend and frontend |
| `docs/05-known-limitations.md` | Before "fixing" something that may be intentional |
| `docs/06-setup-and-deployment.md` | First-time setup or deployment issues |
| `docs/07-api-reference.md` | Adding or changing API endpoints |
| `docs/08-frontend-modules.md` | Adding or changing JS modules |
| `docs/09-development-guide.md` | Common errors, debugging workflow, end-to-end change example |
| `docs/10-apppy-structure.md` | Navigating app.py — section map with line numbers |

## Common Pitfalls

- **Don't add features without checking `docs/05-known-limitations.md`** — several "obvious improvements" are intentionally out of scope (e.g. accounts payable in cash survival, real-time bank balance).
- **Frontend caching**: overview and budget payloads cache for 3 minutes in-browser. During debugging, hard-refresh (`Ctrl+Shift+R`) or wait 3 min to see backend changes reflected.
- **Script load order in index.html is load-order-sensitive** — utilities must load before features. See `docs/08-frontend-modules.md`.
- **Xero token rotation**: Xero may return a new `refresh_token` on each refresh. `refresh_access_token()` always saves the newest token. Never hard-code or cache a refresh token.
