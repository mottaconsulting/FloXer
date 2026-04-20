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
| Backend | Python 3.11, Flask, Gunicorn |
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
│   ├── requirements.txt
│   └── runtime.txt         # Python version pinned for Render
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
├── .env.example            # Environment variable reference — copy to .env.local
├── tokens.json.example     # Xero token store reference
├── render.yaml             # Render deployment config
└── README.md
```

---

## Prerequisites

Before running this app you need accounts and credentials from three services:

1. **Xero** — accounting data source (OAuth2 app)
2. **Supabase** — user authentication and database
3. **Render** — hosting (only needed for production)

The sections below walk through each one step by step.

---

## 1. Xero API Setup

Xero is the accounting platform this app reads data from. The app uses OAuth2 — users log in with their Xero account and grant this app access to their organisation.

### 1.1 Create a Xero Developer Account

1. Go to [developer.xero.com](https://developer.xero.com)
2. Click **Get started for free** and sign up (or log in if you already have a Xero account)
3. You will land on **My Apps** dashboard at [developer.xero.com/app/manage](https://developer.xero.com/app/manage)

### 1.2 Create a New App

1. Click **New app**
2. Fill in the form:
   - **App name**: FloXer (or anything you like)
   - **Company or application URL**: your Render URL (e.g. `https://your-app.onrender.com`) — or `http://localhost:5000` for local dev
   - **OAuth 2.0 redirect URI**: `http://localhost:5000/callback` for local dev
   - **Integration type**: Web app
3. Click **Create app**

### 1.3 Get Your Credentials

After creating the app:

1. Go to the **Configuration** tab of your app
2. Copy the **Client ID** — paste it into your `.env.local` as `XERO_CLIENT_ID`
3. Click **Generate a secret**, copy it immediately (it is only shown once) — paste it as `XERO_CLIENT_SECRET`

> The secret is only shown once. If you lose it, go back to Configuration and generate a new one.

### 1.4 Configure Redirect URIs

The redirect URI must match exactly what the app sends during OAuth. You need one per environment:

| Environment | Redirect URI to add in Xero |
|---|---|
| Local dev | `http://localhost:5000/callback` |
| Render production | `https://your-app.onrender.com/callback` |

To add more:
1. Go to **Configuration** tab → **OAuth 2.0 redirect URI** section
2. Click **+ Add URI** and add the production URL
3. Click **Save**

### 1.5 Required Scopes

The app requests these Xero scopes (already configured in `.env.example`):

```
accounting.transactions
accounting.contacts
accounting.settings
accounting.journals.read
offline_access
```

`offline_access` is required so the app can refresh tokens without forcing the user to re-login every 30 minutes.

### 1.6 Environment Variables for Xero

Add these to your `.env.local`:

```env
XERO_CLIENT_ID=your-client-id-from-step-1.3
XERO_CLIENT_SECRET=your-client-secret-from-step-1.3
XERO_REDIRECT_URI=http://localhost:5000/callback
XERO_SCOPES=accounting.transactions accounting.contacts accounting.settings accounting.journals.read offline_access
```

For production on Render, set `XERO_REDIRECT_URI` to your Render URL:
```env
XERO_REDIRECT_URI=https://your-app.onrender.com/callback
```

### 1.7 Optional: Pin a Specific Xero Organisation

If you only ever use one Xero organisation, you can skip the tenant-selection screen by pinning a tenant ID:

```env
XERO_TENANT_ID=xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx
```

To find your tenant ID: connect to Xero in the app, then visit `/connections` — the tenant ID is shown there.

### 1.8 Optional: Bank Account for Live Balance

To show a live bank balance on the dashboard, tell the app which account to use:

```env
XERO_PRIMARY_BANK_ACCOUNT_CODE=1200
XERO_PRIMARY_BANK_ACCOUNT_NAME=business cheque account
```

These values come from your Xero **Chart of Accounts** (Accounting → Chart of Accounts in Xero).

### 1.9 How Xero Tokens Are Stored

After a user connects Xero, the access token and refresh token are stored in Supabase in the `xero_tokens` table (see the Supabase section for the schema). The app auto-refreshes tokens when they expire — no user action needed.

---

## 2. Supabase Setup

Supabase handles two things in this app:
- **User authentication** (login, signup, password reset) via Supabase Auth
- **Database** (storing Xero tokens per user, and budget rows) via PostgreSQL

### 2.1 Create a Supabase Project

1. Go to [supabase.com](https://supabase.com) and sign up / log in
2. Click **New project**
3. Fill in:
   - **Name**: FloXer (or anything)
   - **Database password**: choose a strong password — save it somewhere safe
   - **Region**: pick one close to your users
4. Click **Create new project** — it takes ~2 minutes to provision

### 2.2 Get Your API Credentials

1. In the Supabase dashboard, go to **Project Settings** (gear icon in the left sidebar) → **API**
2. Copy:
   - **Project URL** → paste as `SUPABASE_URL` in `.env.local`
   - **anon / public key** (under Project API keys) → paste as `SUPABASE_ANON_KEY`

```env
SUPABASE_URL=https://xxxxxxxxxxxxxxxxxxxx.supabase.co
SUPABASE_ANON_KEY=eyJhbGci...long-key-here...
```

### 2.3 Get the Database Connection String

The Flask app connects directly to PostgreSQL for storing tokens and budget data.

1. Go to **Project Settings** → **Database**
2. Scroll to **Connection string** section
3. Select the **URI** tab and choose **Connection pooler** (Supavisor) — important for serverless/Render
4. Copy the connection string → paste as `SUPABASE_DB_URL`

It looks like:
```
postgresql://postgres.xxxxxxxxxxxxxxxxxxxx:YOUR-PASSWORD@aws-0-ap-southeast-2.pooler.supabase.com:6543/postgres?sslmode=require
```

Replace `YOUR-PASSWORD` with the database password you set in step 2.1.

```env
SUPABASE_DB_URL=postgresql://postgres.xxxxxxxxxxxxxxxxxxxx:YOUR-PASSWORD@aws-0-xx-xxx-x.pooler.supabase.com:6543/postgres?sslmode=require
```

### 2.4 Configure Supabase Auth

1. Go to **Authentication** → **URL Configuration** in your Supabase dashboard
2. Set **Site URL** to your production URL: `https://your-app.onrender.com`
3. Under **Redirect URLs**, add:
   - `http://localhost:5000/login/reset` (local dev)
   - `https://your-app.onrender.com/login/reset` (production)

   These are needed for password reset emails to redirect back to the app correctly.

4. Go to **Authentication** → **Email Templates** if you want to customise the signup confirmation or password reset emails.

### 2.5 Create the Required Database Tables

The app needs two tables. Run these SQL statements in Supabase:

1. Go to **SQL Editor** in your Supabase dashboard (left sidebar)
2. Click **New query** and run each block:

**Table 1 — Xero tokens (one row per user per Xero organisation)**

```sql
CREATE TABLE xero_tokens (
    id              SERIAL PRIMARY KEY,
    user_id         UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
    tenant_id       TEXT NOT NULL,
    refresh_token   TEXT NOT NULL,
    access_token    TEXT NOT NULL,
    expires_at      DOUBLE PRECISION NOT NULL,
    scope           TEXT,
    updated_at      TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    UNIQUE (user_id, tenant_id)
);
```

**Table 2 — Budget rows (one row per budget line per user)**

```sql
CREATE TABLE budget_rows (
    id              SERIAL PRIMARY KEY,
    user_id         UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
    journal_date    DATE NOT NULL,
    account_type    TEXT,
    account_name    TEXT,
    account_code    TEXT,
    net_amount      NUMERIC,
    data_category   TEXT DEFAULT 'Budget'
);
```

### 2.6 Row Level Security (Recommended)

Enable RLS so users can only see their own data:

```sql
-- Enable RLS on both tables
ALTER TABLE xero_tokens ENABLE ROW LEVEL SECURITY;
ALTER TABLE budget_rows ENABLE ROW LEVEL SECURITY;

-- Policies: users can only access their own rows
CREATE POLICY "Users access own xero tokens"
    ON xero_tokens FOR ALL
    USING (auth.uid() = user_id);

CREATE POLICY "Users access own budget rows"
    ON budget_rows FOR ALL
    USING (auth.uid() = user_id);
```

> Note: The Flask app connects via `SUPABASE_DB_URL` using the service role connection, which bypasses RLS. RLS protects against direct client-side access.

### 2.7 Create Your First User

Users sign up via the app's `/signup` page. For local testing:

1. Run the app locally (see [Local Setup](#local-setup))
2. Go to `http://localhost:5000/signup`
3. Create an account with your email and password
4. Check your email for a confirmation link (Supabase sends this automatically)
5. Click the link — you can now log in

Alternatively, create a user directly in Supabase: **Authentication** → **Users** → **Add user**.

---

## 3. Render Deployment

Render is the hosting platform. The app is configured via `render.yaml` at the root of the repo.

### 3.1 Create a Render Account

1. Go to [render.com](https://render.com) and sign up with GitHub
2. Authorise Render to access your GitHub account

### 3.2 Connect the Repository

1. In the Render dashboard click **New +** → **Web Service**
2. Select **Build and deploy from a Git repository**
3. Find and select `FloXerAPP` from your GitHub repos
4. Click **Connect**

### 3.3 Configure the Service

Render will detect `render.yaml` automatically. Verify these settings:

| Setting | Value |
|---|---|
| **Name** | mmxeroapi (or rename it) |
| **Region** | Choose closest to your users |
| **Branch** | `main` |
| **Root directory** | `backend` |
| **Build command** | `pip install -r requirements.txt` |
| **Start command** | `gunicorn app:app --workers 1 --threads 4 --timeout 120` |
| **Instance type** | Free (or paid for always-on) |

> The free tier spins down after 15 minutes of inactivity. The first request after a spin-down takes ~30 seconds. Upgrade to a paid instance to avoid this.

### 3.4 Set Environment Variables

In Render, go to your service → **Environment** tab. Add each variable:

| Variable | Value | Where to get it |
|---|---|---|
| `APP_ENV` | `production` | Fixed value |
| `FLASK_SECRET_KEY` | random 48-char string | Run: `python -c "import secrets; print(secrets.token_urlsafe(48))"` |
| `XERO_CLIENT_ID` | your Xero client ID | Xero developer portal → your app → Configuration |
| `XERO_CLIENT_SECRET` | your Xero client secret | Xero developer portal → your app → Configuration |
| `XERO_REDIRECT_URI` | `https://your-app.onrender.com/callback` | Your Render service URL + `/callback` |
| `XERO_SCOPES` | `accounting.transactions accounting.contacts accounting.settings accounting.journals.read offline_access` | Fixed value |
| `SUPABASE_URL` | `https://xxxx.supabase.co` | Supabase → Project Settings → API |
| `SUPABASE_ANON_KEY` | `eyJhbGci...` | Supabase → Project Settings → API |
| `SUPABASE_DB_URL` | `postgresql://postgres...` | Supabase → Project Settings → Database → Connection string |

> Never paste secrets into `render.yaml` — always use the Environment tab in the Render dashboard.

### 3.5 Get Your Render URL

1. After clicking **Create Web Service**, Render will start building
2. The URL appears at the top of the service page — it looks like `https://mmxeroapi.onrender.com`
3. Copy this URL and:
   - Add it to `XERO_REDIRECT_URI` in Render's environment variables
   - Add `https://your-app.onrender.com/callback` as a redirect URI in your Xero app (developer.xero.com)
   - Add it as the **Site URL** in Supabase Auth settings

### 3.6 Deploy

1. Push any commit to the `main` branch — Render auto-deploys
2. Or click **Manual Deploy** → **Deploy latest commit** in the Render dashboard
3. Watch the build logs for errors
4. Once deployed, visit your Render URL — you should see the login page

### 3.7 Troubleshooting Render Deploys

| Symptom | Fix |
|---|---|
| Build fails with missing package | Check `requirements.txt` has all dependencies |
| App crashes on startup | Check all required env vars are set in Render dashboard |
| Xero OAuth redirects to wrong URL | Make sure `XERO_REDIRECT_URI` matches exactly in both Render and the Xero portal |
| 500 errors after login | Check Supabase `SUPABASE_DB_URL` is the pooler connection string, not the direct one |

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

Edit `.env.local` and fill in all values from the sections above.

### 4. Run the app

```bash
python backend/app.py
```

Visit `http://localhost:5000` — you will see the login page.

---

## All Environment Variables Reference

| Variable | Required | Description |
|---|---|---|
| `APP_ENV` | Yes | `development` or `production` |
| `FLASK_SECRET_KEY` | Yes | Random 48+ char string for Flask sessions |
| `XERO_CLIENT_ID` | Yes | From Xero developer portal |
| `XERO_CLIENT_SECRET` | Yes | From Xero developer portal |
| `XERO_REDIRECT_URI` | Yes | OAuth callback — must match Xero portal exactly |
| `XERO_SCOPES` | Yes | Space-separated Xero permission scopes |
| `SUPABASE_URL` | Yes | Your Supabase project URL |
| `SUPABASE_ANON_KEY` | Yes | Supabase anon/public key |
| `SUPABASE_DB_URL` | Yes | Supabase PostgreSQL pooler connection string |
| `XERO_TENANT_ID` | No | Pin a specific Xero organisation |
| `XERO_PRIMARY_BANK_ACCOUNT_CODE` | No | Chart of accounts code for live bank balance |
| `XERO_PRIMARY_BANK_ACCOUNT_NAME` | No | Account name for live bank balance |
| `GST_FREQUENCY` | No | `monthly` or `quarterly` (default: monthly) |
| `PAYG_FREQUENCY` | No | `monthly` or `quarterly` (default: monthly) |
| `SUPER_FREQUENCY` | No | `monthly` or `quarterly` (default: quarterly) |

---

## Security Notes

- Never commit `.env`, `.env.local`, or `tokens.json` — they are in `.gitignore`
- Xero tokens are stored in Supabase, encrypted at rest by Supabase
- The Flask secret key must be different between environments
- Rate limiting is enabled in production (`RATE_LIMIT_WINDOW_SECONDS` / `RATE_LIMIT_MAX_REQUESTS`)
