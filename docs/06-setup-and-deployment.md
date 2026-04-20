# Setup and Deployment

This guide walks a new developer through setting up the three external services FloXer depends on, running it locally, and deploying it to production on Render.

---

## Prerequisites

You need accounts and credentials from three services before the app will start:

- **Xero** — accounting data source (OAuth2 app)
- **Supabase** — user authentication and database
- **Render** — production hosting

---

## 1. Xero API

Xero is the accounting platform FloXer reads data from. The app uses OAuth2 — users log in with their Xero account and grant FloXer access to their organisation.

### 1.1 Create a Xero Developer Account

1. Go to [developer.xero.com](https://developer.xero.com)
2. Click **Get started for free** and sign up, or log in with an existing Xero account
3. You will land on **My Apps** at [developer.xero.com/app/manage](https://developer.xero.com/app/manage)

### 1.2 Create a New App

1. Click **New app**
2. Fill in:
   - **App name**: FloXer (or any name)
   - **Company or application URL**: `http://localhost:5000` for local dev, or your Render URL for production
   - **OAuth 2.0 redirect URI**: `http://localhost:5000/callback`
   - **Integration type**: Web app
3. Click **Create app**

### 1.3 Get Your Credentials

1. Go to the **Configuration** tab of your new app
2. Copy the **Client ID** — this is `XERO_CLIENT_ID`
3. Click **Generate a secret**, copy it immediately — this is `XERO_CLIENT_SECRET`

> The secret is only shown once. If you lose it, go back to Configuration and generate a new one.

### 1.4 Add Redirect URIs

The redirect URI in your Xero app must match exactly what the app sends during OAuth. Add one per environment you use.

To add a URI:
1. Go to **Configuration** tab → **OAuth 2.0 redirect URI** section
2. Click **+ Add URI**
3. Add each one below and click **Save**

| Environment | Redirect URI |
|---|---|
| Local dev | `http://localhost:5000/callback` |
| Render production | `https://your-app.onrender.com/callback` |

### 1.5 Required Scopes

The app requests these scopes (already set in `.env.example`):

```
accounting.transactions
accounting.contacts
accounting.settings
accounting.journals.read
offline_access
```

`offline_access` is required — without it, tokens expire after 30 minutes and users have to reconnect Xero manually.

### 1.6 Environment Variables

```env
XERO_CLIENT_ID=your-client-id
XERO_CLIENT_SECRET=your-client-secret
XERO_REDIRECT_URI=http://localhost:5000/callback
XERO_SCOPES=accounting.transactions accounting.contacts accounting.settings accounting.journals.read offline_access
```

For production, change `XERO_REDIRECT_URI`:

```env
XERO_REDIRECT_URI=https://your-app.onrender.com/callback
```

### 1.7 Optional: Pin a Specific Xero Organisation

If you only use one Xero organisation, you can skip the tenant-selection screen:

```env
XERO_TENANT_ID=xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx
```

To find your tenant ID: connect Xero in the app, then visit `/connections` — the tenant ID appears there.

### 1.8 Optional: Bank Account for Live Balance

To show a live bank balance on the dashboard, tell the app which account to read:

```env
XERO_PRIMARY_BANK_ACCOUNT_CODE=1200
XERO_PRIMARY_BANK_ACCOUNT_NAME=business cheque account
```

These values come from your Xero **Chart of Accounts** (Accounting → Chart of Accounts in Xero).

### 1.9 How Tokens Are Stored

After a user connects Xero, the access and refresh tokens are saved in Supabase in the `xero_tokens` table. The app auto-refreshes tokens when they expire — no user action needed. See section 2 for the table schema.

---

## 2. Supabase

Supabase handles two things:

- **User authentication** — login, signup, and password reset via Supabase Auth
- **Database** — Xero tokens per user, and budget rows, stored in PostgreSQL

### 2.1 Create a Supabase Project

1. Go to [supabase.com](https://supabase.com) and sign up or log in
2. Click **New project**
3. Fill in a name, choose a strong database password (save it — you need it later), pick a region
4. Click **Create new project** — takes about 2 minutes to provision

### 2.2 Get Your API Credentials

1. In the Supabase dashboard go to **Project Settings** (gear icon, bottom of left sidebar) → **API**
2. Copy:
   - **Project URL** → `SUPABASE_URL`
   - **anon / public** key (under Project API keys) → `SUPABASE_ANON_KEY`

```env
SUPABASE_URL=https://xxxxxxxxxxxxxxxxxxxx.supabase.co
SUPABASE_ANON_KEY=eyJhbGci...long-key...
```

### 2.3 Get the Database Connection String

The Flask app connects directly to PostgreSQL using psycopg2.

1. Go to **Project Settings** → **Database**
2. Scroll to the **Connection string** section
3. Select the **URI** tab → choose **Connection pooler (Supavisor)**

> Use the **pooler** connection string, not the direct connection. The direct connection has a very limited number of concurrent connections and will cause errors on Render.

4. Copy the string → `SUPABASE_DB_URL`, replacing `[YOUR-PASSWORD]` with the database password from step 2.1

```env
SUPABASE_DB_URL=postgresql://postgres.xxxxxxxxxxxxxxxxxxxx:YOUR-PASSWORD@aws-0-ap-southeast-2.pooler.supabase.com:6543/postgres?sslmode=require
```

### 2.4 Configure Auth Redirect URLs

For password reset emails to redirect back to the app correctly:

1. Go to **Authentication** → **URL Configuration**
2. Set **Site URL** to: `https://your-app.onrender.com`
3. Under **Redirect URLs**, add both:
   - `http://localhost:5000/login/reset`
   - `https://your-app.onrender.com/login/reset`

### 2.5 Create the Required Database Tables

Run these two queries in Supabase: go to **SQL Editor** (left sidebar) → **New query**, paste, and click **Run**.

**Table 1 — xero_tokens**

Stores one row per user per connected Xero organisation.

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

**Table 2 — budget_rows**

Stores one row per budget line per user.

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

### 2.6 Enable Row Level Security

Protects data so users can only access their own rows:

```sql
ALTER TABLE xero_tokens ENABLE ROW LEVEL SECURITY;
ALTER TABLE budget_rows ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users access own xero tokens"
    ON xero_tokens FOR ALL USING (auth.uid() = user_id);

CREATE POLICY "Users access own budget rows"
    ON budget_rows FOR ALL USING (auth.uid() = user_id);
```

### 2.7 Create Your First User

Users sign up via the app's `/signup` page. After signing up, check your email for a confirmation link — you cannot log in until the email is confirmed.

Alternatively, create a user directly in Supabase: **Authentication** → **Users** → **Add user**.

---

## 3. Local Setup

Once Xero and Supabase are configured:

### 3.1 Clone the Repo

```bash
git clone https://github.com/lorenabdca00/FloXerAPP.git
cd FloXerAPP
```

### 3.2 Create a Virtual Environment

```bash
python -m venv venv
venv\Scripts\activate          # Windows
source venv/bin/activate       # Mac / Linux
pip install -r backend/requirements.txt
```

### 3.3 Set Up Environment Variables

```bash
cp .env.example .env.local
```

Edit `.env.local` and fill in all values from the sections above. See the full variable reference at the end of this file.

### 3.4 Run the App

```bash
python backend/app.py
```

Open `http://localhost:5000` — you should see the login page.

---

## 4. Render Deployment

Render is the production hosting platform. The app is pre-configured via [`render.yaml`](../render.yaml).

### 4.1 Create a Render Account

1. Go to [render.com](https://render.com) and sign up with GitHub
2. Authorise Render to access your GitHub account

### 4.2 Create the Web Service

1. In the Render dashboard click **New +** → **Web Service**
2. Select **Build and deploy from a Git repository**
3. Find and select the `FloXerAPP` repo → **Connect**

Render will detect `render.yaml`. Verify these settings match:

| Setting | Value |
|---|---|
| Root directory | `backend` |
| Build command | `pip install -r requirements.txt` |
| Start command | `gunicorn app:app --workers 1 --threads 4 --timeout 120` |
| Python version | 3.11 (read from `runtime.txt`) |

> **Free tier note:** the free tier spins down after 15 minutes of inactivity. The first request after a spin-down takes ~30 seconds. Upgrade to a paid instance to avoid this.

### 4.3 Set Environment Variables

In your Render service → **Environment** tab, add each variable:

| Variable | Value | Where to get it |
|---|---|---|
| `APP_ENV` | `production` | Fixed value |
| `FLASK_SECRET_KEY` | random 48-char string | Run: `python -c "import secrets; print(secrets.token_urlsafe(48))"` |
| `XERO_CLIENT_ID` | your client ID | Xero portal → your app → Configuration |
| `XERO_CLIENT_SECRET` | your client secret | Xero portal → your app → Configuration |
| `XERO_REDIRECT_URI` | `https://your-app.onrender.com/callback` | Your Render URL + `/callback` |
| `XERO_SCOPES` | `accounting.transactions accounting.contacts accounting.settings accounting.journals.read offline_access` | Fixed value |
| `SUPABASE_URL` | `https://xxxx.supabase.co` | Supabase → Project Settings → API |
| `SUPABASE_ANON_KEY` | `eyJhbGci...` | Supabase → Project Settings → API |
| `SUPABASE_DB_URL` | `postgresql://postgres...` | Supabase → Project Settings → Database → Connection string (pooler) |

> Never put secrets in `render.yaml` — use the Environment tab only.

### 4.4 After First Deploy — Update Redirect URIs

Once Render assigns your app URL (e.g. `https://mmxeroapi.onrender.com`):

1. **Xero portal** → add `https://your-app.onrender.com/callback` as a redirect URI
2. **Supabase Auth** → set Site URL and add `/login/reset` redirect URL (see section 2.4)
3. **Render env vars** → update `XERO_REDIRECT_URI` to the production URL

Then trigger a redeploy: **Manual Deploy** → **Deploy latest commit**.

### 4.5 Troubleshooting

| Symptom | Fix |
|---|---|
| Build fails | Check `requirements.txt` includes all dependencies |
| App crashes on startup | Check all required env vars are set in the Render dashboard |
| Xero OAuth fails | `XERO_REDIRECT_URI` must match exactly in both Render env vars and the Xero portal |
| 500 errors after login | Make sure `SUPABASE_DB_URL` uses the **pooler** connection string, not the direct one |
| Slow first load | Expected on free tier — upgrade to paid for always-on |

---

## Full Environment Variable Reference

| Variable | Required | Description |
|---|---|---|
| `APP_ENV` | Yes | `development` or `production` |
| `FLASK_SECRET_KEY` | Yes | Random 48+ char string for Flask sessions |
| `XERO_CLIENT_ID` | Yes | From Xero developer portal |
| `XERO_CLIENT_SECRET` | Yes | From Xero developer portal |
| `XERO_REDIRECT_URI` | Yes | OAuth callback — must match Xero portal exactly |
| `XERO_SCOPES` | Yes | Space-separated Xero permission scopes |
| `SUPABASE_URL` | Yes | Supabase project URL |
| `SUPABASE_ANON_KEY` | Yes | Supabase anon/public key |
| `SUPABASE_DB_URL` | Yes | Supabase PostgreSQL pooler connection string |
| `XERO_TENANT_ID` | No | Pin a specific Xero organisation |
| `XERO_PRIMARY_BANK_ACCOUNT_CODE` | No | Chart of accounts code for live bank balance |
| `XERO_PRIMARY_BANK_ACCOUNT_NAME` | No | Account name for live bank balance |
| `GST_FREQUENCY` | No | `monthly` or `quarterly` (default: monthly) |
| `PAYG_FREQUENCY` | No | `monthly` or `quarterly` (default: monthly) |
| `SUPER_FREQUENCY` | No | `monthly` or `quarterly` (default: quarterly) |
