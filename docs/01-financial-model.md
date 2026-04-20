# Financial Model

This document explains the current cash logic used across the dashboard and cash timeline.

The most important concept in FloXer is that not all money in the bank is available to spend.

## Core Cash Logic

The current model is:

```text
Starting Point = Bank Balance - Tax committed this month
```

Then the future cash walk is:

```text
Closing Cash = Opening Cash + Projected Revenue - Projected Expenses - Future Tax Obligations
```

This creates a cash view that is stricter than raw bank balance. It is designed to answer:

- how much cash is actually usable now
- when cash is projected to go negative
- how future budget and tax obligations affect runway

## Definitions

### Bank Balance

The current cash balance shown from Xero, or a manual override entered by the user when Xero is not fully reconciled.

This is gross cash only. It does not subtract commitments.

### Tax Committed This Month

Tax already committed from current cash.

This represents tax obligations that are due this month or overdue. In the current product scope, this is the only amount removed immediately from available cash.

### Starting Point

The amount of cash available after removing tax already committed this month.

```text
Starting Point = Bank Balance - Tax committed this month
```

This is the number that should be used as the opening point for forward-looking cash analysis.

### Future Tax Obligations

Projected tax obligations due in future months, based on the tax schedule logic.

These are not removed from cash immediately. They are applied month by month in the cash timeline.

### Operating Forecast

The budget-based forward projection:

- projected revenue
- projected expenses
- operating net

Operating net is:

```text
Operating Net = Projected Revenue - Projected Expenses
```

## Current Scope Decision

For now, the out-of-cash model is intentionally simplified.

Included:

- tax committed this month
- future tax obligations
- future budget revenue
- future budget expenses

Excluded for now:

- accounts payable as a separate committed-cash input
- non-tax liabilities outside the current tax projection model

This is intentional. The assumption is that expected supplier payments should be represented in the budget page for now, while tax remains the special commitment that cannot be freely spent.

## Out of Cash Logic

The Out of Cash card answers:

- if the business is already in red now
- if not, when the next negative day or month happens
- how many days remain until that point

Current interpretation:

- if `Starting Point` is already negative, the state is `now`
- otherwise, the system projects forward using budget plus future tax obligations
- the first future negative point becomes the out-of-cash date/month

## Cash Timeline Logic

The cash timeline should be read month by month:

```text
Opening Cash
+ Revenue
- Expenses
- Tax Obligations
= Closing Cash
```

The next month then starts from the prior month’s closing cash.

This is the main detailed view behind the Out of Cash card.

## Manual Bank Balance Override

If the user edits the bank balance:

- Bank Balance changes
- Starting Point changes
- Out of Cash changes
- Cash Timeline changes

The tax commitment does not change because it is still the same committed obligation.

So the formula becomes:

```text
Starting Point = Edited Bank Balance - Tax committed this month
```

## Sign Convention

FloXer works with Xero-style accounting signs internally, but the UI should always explain numbers in business language:

- revenue shown as positive inflow
- expenses shown as negative outflow in the UI
- tax obligations shown as negative outflow in the UI

The documentation and UI should always describe the model from a cash perspective, not an accounting-journal perspective.

## Product Intent

The purpose of this model is not to build a perfect treasury engine.

The purpose is to make cash understandable:

- what is in the bank
- what is already committed
- what is left to operate with
- how long that cash lasts

That clarity is the core financial model of FloXer today.
