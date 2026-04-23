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

The dashboard shows two charts side by side. Both span the full selected financial year (one bar or data point per month) and split at the current month — past months show actual Xero data, future months show projections from budget and tax schedules.

A dashed vertical line with a "Forecast" label marks the boundary between actual and projected data on both charts.

---

#### Cash Outlook (bar chart)

**What it shows:** cumulative net cash position, built up month by month across the financial year.

**How it is calculated:**

Each bar represents the running total of:

```text
Revenue − Expenses − Tax obligations
```

accumulated from the start of the financial year through that month. It is not a bank balance — it is the net operating surplus or deficit built up over the year.

**Colour coding:**

| Bar colour | Meaning |
|---|---|
| Solid blue | Positive cumulative cash, actual months |
| Solid pink | Negative cumulative cash, actual months |
| Light blue | Positive cumulative cash, projected months |
| Light pink | Negative cumulative cash, projected months |

Projected bars (future months) use reduced opacity to signal they are estimates.

**Key reading:** when bars turn pink, the business has consumed more cash than it has generated from that point in the year. A bar crossing zero into negative territory is a visual warning consistent with the Out of Cash card.

**Tax obligations:** future months include scheduled tax payments (GST, PAYG, Super) added to projected expenses. This is what makes the projected expense line in the companion chart steeper than the raw budget line.

---

#### Revenue & Expenses (line chart)

**What it shows:** monthly revenue and expenses as separate lines, with actual and projected series split at the current month.

**Four series:**

| Series | Style | Meaning |
|---|---|---|
| Revenue | Solid blue line | Actual revenue from Xero journals |
| Revenue Projection | Dashed blue line | Projected revenue from budget |
| Expenses | Solid pink line | Actual expenses from Xero journals |
| Expenses + Tax Projection | Dashed pink line | Projected expenses including future tax obligations |

Actual and projected series connect at the current month so the chart reads as a continuous line.

**Tooltip behaviour:** hovering over a month shows values for all four series. For projected months that include tax obligations, the tooltip footer adds a line:

```text
Includes future tax obligations: $X,XXX
```

This lets users see exactly how much of the projected expense line is tax versus operating costs.

**Legend:** the panel shows a Revenue (blue) and Expenses (pink) legend dot — these refer to the actual series. The projected series use the same colours at reduced opacity.

---

#### What these charts are not

- They do not replace the Out of Cash card — the card is the primary cash risk indicator
- The Cash Outlook chart is not a cash flow statement — it does not include accounts payable, capital items, or opening bank balance
- The Revenue & Expenses chart does not show profit margin — use the Profit YTD card for that

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
