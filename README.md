# FloXer

A financial dashboard that connects to **Xero** to give you a real-time view of your business finances — cash position, liabilities, sales trends, and more.

Built with a **Flask** backend and a **vanilla JS** frontend. Deployed on **Render**.

---

## Features

- **Xero OAuth2** authentication — connect your Xero organisation securely
- **Dashboard** — summary of cash, revenue, expenses, and outstanding invoices
- **Cash Timeline** — projected cash flow based on invoices and liabilities
- **Liabilities** — GST, PAYG, Super obligations with due dates
- **Sales by month / top customers / sales by status** charts
- **Budget** — manual budget input with actual vs budget comparison
- **Supabase** — user authentication (login, signup, password reset)
- Rate limiting and proxy-safe production setup

---

## Tech Stack

| Layer | Technology |
|---|---|
| Backend | Python 3, Flask, Gunicorn |
| Frontend | Vanilla JavaScript, HTML, CSS |
| Accounting data | Xero API (OAuth2) |
| User auth / DB | Supabase (PostgreSQL) |
| Deployment | Render |

---

## Project Structure

```
FloXerAPP/
├── backend/
│   ├── app.py              # Flask app — all routes and Xero API logic
│   └── requirements.txt
├── frontend/
│   ├── index.html          # Main dashboard
│   ├── login.html
│   ├── signup.html
│   ├── reset.html
│   └── js/
│       ├── main.js
│       └── features/
│           ├── dashboard.js
│           ├── cash-timeline.js
│           └── ...
├── .env.example            # Environment variable reference
├── tokens.json.example     # Xero token store reference
├── render.yaml             # Render deployment config
└── README.md
```

---

## Local Setup

### 1. Clone the repo

```bash
git clone https://github.com/lorenabdca00/FloXerAPP.git
cd FloXerAPP
```

### 2. Create a Python virtual environment

```bash
python -m venv venv
source venv/bin/activate        # Mac/Linux
venv\Scripts\activate           # Windows
pip install -r backend/requirements.txt
```

### 3. Set up environment variables

```bash
cp .env.example .env.local
```

Edit `.env.local` and fill in all required values (see [Environment Variables](#environment-variables) below).

### 4. Set up Xero credentials

- Go to [developer.xero.com](https://developer.xero.com) and create an app
- Set the redirect URI to `http://localhost:5000/callback`
- Copy your Client ID and Client Secret into `.env.local`

### 5. Run the app

```bash
python backend/app.py
```

Visit `http://localhost:5000` in your browser.

---

## Environment Variables

See [.env.example](.env.example) for the full reference. Key variables:

| Variable | Description |
|---|---|
| `FLASK_SECRET_KEY` | Random secret key for Flask sessions |
| `XERO_CLIENT_ID` | From Xero developer portal |
| `XERO_CLIENT_SECRET` | From Xero developer portal |
| `XERO_REDIRECT_URI` | OAuth callback URL |
| `SUPABASE_URL` | Your Supabase project URL |
| `SUPABASE_ANON_KEY` | Supabase anon/public key |
| `SUPABASE_DB_URL` | Supabase PostgreSQL connection string |
| `APP_ENV` | `development` or `production` |

---

## Deployment (Render)

This app is configured for [Render](https://render.com) via `render.yaml`.

1. Push to GitHub
2. Create a new **Web Service** on Render pointing to this repo
3. Set all environment variables in the Render dashboard
4. Render will auto-deploy on every push to `main`

---

## Security Notes

- Never commit `.env`, `.env.local`, or `tokens.json` — they are in `.gitignore`
- Xero tokens are stored server-side only
- Rate limiting is enabled in production
