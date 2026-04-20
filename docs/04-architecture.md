# Architecture

FloXer uses a simple architecture:

- Flask backend
- vanilla JavaScript frontend
- Xero as the accounting data source
- Supabase for authentication and persistence

## High-Level Flow

The main application flow is:

```text
Browser
  -> Flask routes / API
  -> Xero API + Supabase
  -> JSON payload
  -> Frontend rendering
```

For the dashboard, the most important path is:

```text
Xero data + budget data
-> backend calculations
-> /api/dashboard/overview
-> frontend renderers
-> cards, charts, and cash timeline
```

## Backend Responsibilities

The backend is responsible for:

- authentication/session handling
- Xero OAuth and token refresh
- loading accounting data from Xero
- loading budget data from Supabase
- building the overview payload
- calculating tax obligations and projection inputs

The main file is:

- `backend/app.py`

This file currently contains both route handlers and financial logic, which makes it powerful but also means logic can become crowded over time.

## Frontend Responsibilities

The frontend is responsible for:

- fetching overview and budget data
- rendering cards, charts, tables, and timeline views
- handling local UI state
- applying the manual bank balance override
- rebuilding the forward cash timeline after an override

The frontend is plain JavaScript loaded directly in `frontend/index.html`.

Important folders/files:

- `frontend/index.html`
- `frontend/js/main.js`
- `frontend/js/kpi.js`
- `frontend/js/charts.js`
- `frontend/js/ui.js`
- `frontend/js/features/dashboard.js`
- `frontend/js/features/cash-timeline.js`
- `frontend/js/features/transactions.js`
- `frontend/js/features/budget.js`

## Data Sources

FloXer combines two main data sources:

### Xero

Used for:

- journals
- balance sheet / bank balance
- invoices and accounting activity
- tax-related balances

### Supabase

Used for:

- app users and login
- Xero token storage
- budget row storage

## Overview Payload

The overview endpoint is the central contract between backend and frontend.

It groups data into sections such as:

- `meta`
- `kpis`
- `obligations`
- `projection`
- `charts`

This payload is effectively the main application model for the dashboard experience.

## Important Architectural Nuance

There is one important special case in the current architecture:

- the backend computes the base projection
- the frontend can rebuild the projection after a manual bank balance override

Why this exists:

- the user may override bank balance locally
- that override is not persisted to the backend
- the dashboard still needs updated out-of-cash and timeline logic immediately

So the frontend becomes the active source of truth for projection after a balance override.

This is practical, but it means backend projection values and rendered frontend values can diverge if someone does not understand the override path.

## Architectural Risk Areas

The codebase is straightforward, but there are a few recurring risks:

- financial logic duplicated between backend and frontend
- stale frontend fallbacks to older payload shapes
- mixed naming for the same concept across pages
- one large `app.py` carrying many responsibilities

These are not fatal issues, but they are the main places where inconsistencies can grow.

## Future Direction

A good long-term direction would be:

- keep one clear canonical financial model
- reduce duplicate projection logic where possible
- keep naming identical across payload, UI, and documentation
- slowly extract backend financial logic into dedicated modules

That would improve maintainability without changing the product vision.
