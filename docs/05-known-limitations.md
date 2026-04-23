# Known Limitations

This document captures important current limitations so future changes stay grounded in reality.

## 1. Tax-Only Commitment Model

The current cash survival model only removes tax commitments from immediately available cash.

That means:

- Starting Point subtracts tax committed this month
- future cash projection subtracts future tax obligations
- accounts payable are not separately deducted as committed cash

This is intentional for now, but it is still a limitation if someone expects a fuller liability model.

## 2. Manual Bank Balance Override Is Frontend-Only

When the bank balance is edited by the user:

- the override is applied in the frontend
- the frontend rebuilds the projection locally
- the backend payload itself does not become the new source of truth

This means API values and rendered UI values can differ after an override unless the reader understands that the override lives in the browser.

## 3. Backend And Frontend Projection Logic Must Stay In Sync

Both backend and frontend participate in the projection flow.

If one side changes and the other does not, the app can show inconsistent results across:

- dashboard cards
- out-of-cash messaging
- cash timeline details

## 4. Naming Can Drift

The app uses several closely related concepts:

- Bank Balance
- Tax committed this month
- Starting Point
- Projected closing cash
- Out of Cash

If labels differ across cards, tooltips, timeline, and payload fields, users can quickly lose trust in the numbers.

## 5. Large Backend File

`backend/app.py` currently contains:

- route definitions
- Xero integration logic
- Supabase access
- financial calculations
- projection assembly

This works, but it makes the code harder to reason about and increases the chance of old logic surviving after a refactor.

## 6. Budget Quality Directly Affects Forecast Quality

Future cash logic depends heavily on the budget page.

If budget inputs are incomplete, stale, or structurally inconsistent, then:

- Out of Cash becomes less reliable
- Cash Timeline becomes less reliable
- projected closing cash becomes less reliable

The product can only be as predictive as the budget inputs allow.

## 7. Xero Data Quality Affects Current Cash Accuracy

If Xero is not fully reconciled:

- bank balance may be misleading
- tax balances may lag or appear unusual
- the user may need to rely on manual bank balance override

This is a product reality, not necessarily a bug.

## 8. Documentation And Code Can Drift

Because the product evolved quickly, documentation can become out of sync with implementation if not reviewed after major dashboard changes.

The main areas most likely to drift are:

- payload shape
- script/module load order
- projection field names
- page terminology

## 10. Security Hardening Required Before Wider Use

The current login and session setup was intentionally kept simple to speed up development.

Specific issues that need to be addressed:

- **Persistent test account**: there is a long-lived test account in use that has not been rotated. Before the app is shared with real users, this account should be removed or replaced with a properly scoped credential.
- **Supabase signup errors**: new user signup through the app currently triggers intermittent errors from Supabase. The root cause has not been fully investigated. This needs to be diagnosed and resolved before onboarding real users — a broken signup flow is a hard blocker for any public launch.
- **Session lifetime**: the current session is set to 8 hours. This was chosen for development convenience and may need tightening for a production environment depending on the risk profile of the users.

None of these are complex to fix, but they need deliberate attention before the app handles real business data.

## 11. Committed Tax Calculation Needs Review

The current logic for "tax committed this month" (the amount subtracted from bank balance to produce Starting Point) has two unresolved questions:

**Source data reliability:**
The committed tax amounts are derived from Xero balance sheet liability accounts (GST, PAYG, Super). The accuracy of these numbers depends on how well the Xero file is set up and reconciled. If tax accounts are not updated consistently — or if the account codes do not match the patterns the app looks for — the committed amount can be wrong without any visible error.

**Frequency and due date logic:**
The app auto-detects whether GST and PAYG are lodged monthly or quarterly by looking at transaction history. This detection can be wrong for new Xero files, recently changed lodgement frequencies, or files with sparse history. When detection is wrong, the due dates shift and the committed vs future split changes, which flows through to Starting Point and the full cash projection.

The right long-term fix is to make it clearer where committed tax comes from and to give the user a way to verify or override the detected frequency — similar to how bank balance can be overridden today.

Until this is resolved, treat committed tax figures as estimates. Use `/api/debug/balance-sheet` to inspect what the app is reading from Xero, and check detected frequencies via `/api/debug/config`.

## 9. Some Complexity Is Product Complexity, Not Just Code Complexity

Cash forecasting is inherently a layered problem:

- actual historical performance
- current bank position
- committed obligations
- future tax
- forward operating assumptions

Some complexity in the codebase exists because the business question itself is complex. The goal should be to organize that complexity clearly, not pretend it does not exist.
