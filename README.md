# FloXer

FloXer is a Xero-connected cash clarity app for small businesses.

It combines:

- Xero accounting data
- manual budget inputs
- current tax commitments
- future tax obligations

to explain:

- current business performance
- current bank cash
- usable cash after tax commitments
- when cash is projected to run out

Built with a Flask backend and a vanilla JavaScript frontend.

## Documentation

Detailed docs live in [`docs/`](./docs):

- [Financial Model](./docs/01-financial-model.md)
- [Product Overview](./docs/02-product-overview.md)
- [Dashboard And Pages](./docs/03-dashboard-and-pages.md)
- [Architecture](./docs/04-architecture.md)
- [Known Limitations](./docs/05-known-limitations.md)
- [Setup and Deployment](./docs/06-setup-and-deployment.md)
- [API Reference](./docs/07-api-reference.md)
- [Frontend Modules](./docs/08-frontend-modules.md)
- [Development Guide](./docs/09-development-guide.md)
- [app.py Structure Map](./docs/10-apppy-structure.md)

## Current Product Model

The current cash model is:

```text
Starting Point = Bank Balance - Tax committed this month
```

Then FloXer projects forward using:

```text
Starting Point + projected revenue - projected expenses - future tax obligations
```

Important current scope decision:

- `Out of Cash` is currently tax-only for obligations
- accounts payable are intentionally excluded from the cash survival model

## Tech Stack

| Layer | Technology |
|---|---|
| Backend | Python, Flask, Gunicorn |
| Frontend | Vanilla JavaScript, HTML, CSS |
| Accounting data | Xero API |
| User auth / DB | Supabase |
| Deployment | Render |

## Project Structure

```text
FloXerAPP/
  backend/
    app.py
    requirements.txt
  frontend/
    index.html
    js/
      kpi.js
      main.js
      features/
        dashboard.js
        cash-timeline.js
        ...
  docs/
    01-financial-model.md
    02-product-overview.md
    03-dashboard-and-pages.md
    04-architecture.md
    05-known-limitations.md
    06-setup-and-deployment.md
    07-api-reference.md
    08-frontend-modules.md
    09-development-guide.md
  .env.example
  render.yaml
  README.md
```

## Local Setup

### 1. Clone the repo

```bash
git clone <repo-url>
cd FloXerAPP
```

### 2. Create a virtual environment

```bash
python -m venv venv
venv\Scripts\activate
pip install -r backend/requirements.txt
```

### 3. Configure environment variables

Use [.env.example](./.env.example) as the reference and create your local environment file.

Key variables include:

| Variable | Description |
|---|---|
| `FLASK_SECRET_KEY` | Flask session secret |
| `XERO_CLIENT_ID` | Xero app client ID |
| `XERO_CLIENT_SECRET` | Xero app client secret |
| `XERO_REDIRECT_URI` | OAuth callback URL |
| `SUPABASE_URL` | Supabase project URL |
| `SUPABASE_ANON_KEY` | Supabase public key |
| `SUPABASE_DB_URL` | Supabase database connection |

### 4. Run the app

```bash
python backend/app.py
```

Then open `http://localhost:5000`.

## Deployment

Render deployment is configured through [`render.yaml`](./render.yaml).

## Security Notes

- Do not commit `.env`, `.env.local`, or live token files
- Xero tokens are stored server-side
- Rate limiting is enabled in production
