# Dashboard And Pages

This document explains the purpose of each major page and the intended meaning of the main dashboard elements.

## Dashboard

The dashboard is the highest-level summary of the business.

It should help a user understand performance, current cash position, and cash risk in a few seconds.

### Profit YTD Card

This card should show the company’s profit year-to-date for the selected financial year.

Meaning:

- it is a performance measure
- it is not a cash number
- it should respond to the selected financial year

Recommended label style:

```text
Profit YTD (FY 2025-2026)
```

When a different year is selected, the label should update accordingly.

### Bank Balance Card

This card shows the current bank balance.

Important nuance:

- this number may not always be accurate if Xero is not fully reconciled
- that is why the card supports a manual edit/override

When edited:

- the edited bank balance becomes the active cash input for dashboard cash logic
- this should affect Starting Point, Out of Cash, and Cash Timeline

This card is gross cash only. It should not subtract tax commitments directly.

### Out of Cash Card

This is one of the most important cards in the product.

It should answer:

- are we already out of cash now
- if not, how many days remain
- what future projection leads to that answer

Its logic should be based on:

- Starting Point
- budget forecast
- future tax obligations

The breakdown behind the card should explain:

- current bank balance
- tax committed this month
- Starting Point
- projected revenue to FY end
- projected expenses to FY end
- future tax obligations
- projected closing cash

The card should preserve its current footprint and visual hierarchy. Extra explanation should be shown only when expanded.

### Charts

The dashboard charts provide supporting context, not the primary decision logic.

They should help explain:

- actual vs projected performance
- future operating outlook
- cash direction

Chart titles and tooltips should use cash language where appropriate and stay consistent with the dashboard model.

## Cash Timeline Page

The Cash Timeline page is the detailed explanation layer for the Out of Cash card.

It should show:

- how Starting Point is built
- how each future month changes cash
- how tax obligations affect the walk
- where the business goes negative, if it does

The intended monthly structure is:

```text
Opening cash
+ Revenue
- Expenses
- Tax obligations
= Closing cash
```

The page should emphasize:

- Starting Point at the top
- month title and status
- section hierarchy with smaller helper labels
- Closing cash as the primary monthly result

## Transactions Page

This page is the audit and detail view.

It lets the user inspect underlying accounting entries and trace unexpected numbers back to source records.

## Budget Input Page

This page is where future assumptions are managed.

The cash model depends on it for:

- future revenue
- future expenses

If a future payment should be planned operationally, it should generally appear here under the current product scope.

## Navigation Intent

Each page has a different job:

- Dashboard: quick understanding
- Cash Timeline: explanation of future cash path
- Transactions: source-detail checking
- Budget Input: future assumption control

Together these pages should form one coherent flow, not four separate tools.
