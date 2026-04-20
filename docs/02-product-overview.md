# Product Overview

FloXer is a Xero-connected cash clarity app for small businesses.

It is designed to help a business owner move from raw accounting data to practical cash decisions.

Instead of only showing profit or bank balance, FloXer tries to answer:

- how the business is performing
- how much cash is really available
- what cash is already committed to tax
- how future budget and tax obligations affect survival

## Main Product Goal

The product helps users understand the difference between:

- profit
- bank balance
- usable cash

This distinction is critical because a company can:

- show profit and still run out of cash
- have money in the bank that is already committed
- look healthy on paper but be under pressure in the next month

## Current Product Structure

The app currently revolves around four main areas:

### Dashboard

The dashboard gives the fast, high-level view:

- Profit YTD
- Bank Balance
- Out of Cash
- charts for performance and forecast context

### Cash Timeline

The cash timeline explains the month-by-month cash walk:

- starting point
- future budget revenue
- future budget expenses
- future tax obligations
- closing cash by month

This is the explanation layer behind the Out of Cash card.

### Transactions

The transactions page lets the user inspect underlying Xero journal activity and understand where numbers are coming from.

### Budget Input

The budget page is where future revenue and expense assumptions are maintained.

The budget is a key part of the forward-looking cash model.

## Current Product Language

The current product model is built around these business concepts:

- `Profit YTD`
- `Bank Balance`
- `Tax committed this month`
- `Starting Point`
- `Future tax obligations`
- `Projected closing cash`
- `Out of Cash`

The product should prefer these labels consistently across cards, charts, and timeline views.

## Current Scope Decision

The current cash model intentionally treats tax as the main committed obligation removed from available cash.

For now:

- tax is treated as committed cash
- future tax is projected as future obligations
- accounts payable are not separately treated as committed cash in the main cash survival model

This keeps the model simpler and easier to explain.

## What FloXer Is Not

FloXer is not trying to be:

- a full ERP
- a complete treasury forecasting platform
- a replacement for Xero

It sits on top of Xero and turns accounting records plus budget assumptions into a practical cash narrative.

## Ideal User Outcome

After opening FloXer, a user should be able to answer:

- Are we profitable this year?
- What is our real cash position today?
- How much of our bank cash is already committed?
- If nothing changes, when do we run out of cash?
- Which future months are tight and why?

That is the core product promise.
