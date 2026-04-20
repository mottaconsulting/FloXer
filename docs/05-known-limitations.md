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

## 9. Some Complexity Is Product Complexity, Not Just Code Complexity

Cash forecasting is inherently a layered problem:

- actual historical performance
- current bank position
- committed obligations
- future tax
- forward operating assumptions

Some complexity in the codebase exists because the business question itself is complex. The goal should be to organize that complexity clearly, not pretend it does not exist.
