# Backlog

Known limitations, bugs, and improvement items. Resolved items are marked ✅.

---

## Deployment

✅ **Deploy to production hosting**
App deployed to Fly.io (Sydney region), always-on, HTTPS enforced, auto-deploys from `main` branch.

---

## Bugs Fixed

✅ **Supabase signup errors** *(was: Security Hardening #10)*
Signup was failing due to a space in the `SUPABASE_URL` environment variable. Fixed and verified working.

✅ **Logout deletes from non-existent `users` table**
`/auth/logout` was running `DELETE FROM users WHERE id = %s` — a table that doesn't exist. Users are managed by Supabase Auth only. The erroneous query has been removed.

---

## Security

**Security hardening required before wider use** *(partially addressed)*

Remaining items:
- **Persistent test account**: long-lived test account should be removed or rotated before sharing with real users
- **Session lifetime**: currently set to 8 hours for development convenience — may need tightening for production depending on user risk profile

---

## Database / Migrations

✅ **No formal migration files**
Initial schema migration created at `supabase/migrations/001_initial_schema.sql` covering `xero_tokens`, `budget_rows`, RLS, and user-scoped policies.

---

## Financial Model

**1. Tax-Only Commitment Model**
The cash survival model only removes tax commitments from available cash. Accounts payable are not separately deducted. Intentional for now but limits the liability model.

**6. Budget Quality Directly Affects Forecast Quality**
Out of Cash, Cash Timeline, and projected closing cash are only as reliable as the budget inputs. No mitigation planned yet.

**7. Xero Data Quality Affects Current Cash Accuracy**
If Xero is not fully reconciled, bank balance and tax balances may be misleading. Product reality — user must rely on manual bank balance override.

**11. Committed Tax Calculation Needs Review**
- Committed tax amounts depend on Xero account codes matching expected patterns — silent failures possible
- Auto-detection of GST/PAYG lodgement frequency can be wrong for new or sparse Xero files
- Long-term fix: let users verify or override detected frequency (similar to bank balance override)
- Workaround: use `/api/debug/balance-sheet` and `/api/debug/config` to inspect

---

## Architecture

**2. Manual Bank Balance Override Is Frontend-Only**
Override is applied in the browser and rebuilds the projection locally. Backend payload does not update. API values and rendered UI values can differ after an override.

**3. Backend And Frontend Projection Logic Must Stay In Sync**
Both sides participate in projection. If one changes without the other, dashboard cards, out-of-cash messaging, and cash timeline can show inconsistent results.

**5. Large Backend File**
`backend/app.py` contains routes, Xero integration, Supabase access, financial calculations, and projection assembly in one file. Works but makes reasoning and refactoring harder.

**9. Some Complexity Is Product Complexity**
Cash forecasting is inherently layered (actuals, bank position, committed obligations, future tax, forward assumptions). Some codebase complexity reflects the business problem itself.

---

## UX / Naming

**4. Naming Can Drift**
Closely related concepts (Bank Balance, Tax committed this month, Starting Point, Projected closing cash, Out of Cash) can drift across cards, tooltips, timeline, and payload fields. Needs periodic review.

---

## Documentation

**8. Documentation And Code Can Drift**
Docs can become out of sync after major dashboard changes. Areas most at risk: payload shape, script/module load order, projection field names, page terminology.
