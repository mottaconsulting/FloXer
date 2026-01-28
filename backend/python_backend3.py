from flask import Flask, jsonify, send_from_directory, request, redirect
from flask_cors import CORS
import requests
import json
import os
import time
import urllib.parse
from datetime import datetime
from dotenv import load_dotenv
import pandas as pd
from pathlib import Path


# ----------------------------
# Why this file exists
# ----------------------------
# This Flask app does two jobs:
# 1) Auth: Connect to Xero (OAuth2), store tokens, refresh access tokens.
# 2) Data API: Provide clean JSON endpoints for the frontend.
#
# Beginner-friendly rule:
# - Backend (this file) should *fetch + compute*.
# - Frontend (index.html) should *render*.

load_dotenv()

# app = Flask(__name__)
# CORS(app)

BASE_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DATA_MODE = os.getenv("DATA_MODE", "xero").lower()  # "xero" or "csv"
EXPORTS_DIR = Path(os.getenv("EXPORTS_DIR", os.path.join(BASE_DIR, "exports")))
FRONTEND_DIR = os.path.join(BASE_DIR, "frontend")

app = Flask(__name__, static_folder=FRONTEND_DIR, static_url_path="")
CORS(app)
print("RUNNING FILE:", __file__)
print("FRONTEND_DIR:", FRONTEND_DIR)
print("INDEX EXISTS:", os.path.exists(os.path.join(FRONTEND_DIR, "index.html")))



# ----------------------------
# Config
# ----------------------------
CLIENT_ID = os.getenv("XERO_CLIENT_ID")
CLIENT_SECRET = os.getenv("XERO_CLIENT_SECRET")

# Optional: you can still hardcode tenant id in .env while learning.
# Better: we auto-save tenant_id into tokens.json after /connections.
TENANT_ID_ENV = os.getenv("XERO_TENANT_ID")

TOKENS_FILE = os.getenv("TOKENS_FILE", "tokens.json")
REDIRECT_URI = os.getenv("XERO_REDIRECT_URI", "http://localhost:5000/callback")

# Keep scopes simple: only request what you use.
SCOPES = os.getenv(
    "XERO_SCOPES",
    "accounting.transactions accounting.contacts accounting.settings accounting.journals.read offline_access",
)

XERO_AUTHORIZE_URL = "https://login.xero.com/identity/connect/authorize"
XERO_TOKEN_URL = "https://identity.xero.com/connect/token"
XERO_CONNECTIONS_URL = "https://api.xero.com/connections"
XERO_API_BASE = "https://api.xero.com/api.xro/2.0"


# ----------------------------
# Token + tenant helpers
# ----------------------------
def load_tokens() -> dict:
    if os.path.exists(TOKENS_FILE):
        with open(TOKENS_FILE, "r") as f:
            return json.load(f)
    return {}


def save_tokens(tokens: dict) -> None:
    with open(TOKENS_FILE, "w") as f:
        json.dump(tokens, f, indent=2)


def get_tenant_id() -> str | None:
    """Prefer tenant_id saved in tokens.json; fall back to .env."""
    tokens = load_tokens()
    return tokens.get("tenant_id") or TENANT_ID_ENV


def token_is_valid(tokens: dict) -> bool:
    now = int(time.time())
    return bool(tokens.get("access_token")) and now < int(tokens.get("expires_at", 0))


def refresh_access_token(tokens: dict) -> dict:
    """Refreshes the access token using refresh_token.

    Important: Xero may rotate refresh tokens.
    If the response includes a new refresh_token, you must save it.
    """
    if not tokens.get("refresh_token"):
        raise Exception(
            "Access token expired and no refresh token available. Please re-authorize at http://localhost:5000/auth"
        )

    resp = requests.post(
        XERO_TOKEN_URL,
        data={
            "grant_type": "refresh_token",
            "refresh_token": tokens["refresh_token"],
        },
        auth=(CLIENT_ID, CLIENT_SECRET),
    )
    resp.raise_for_status()

    new_tokens = resp.json()

    # keep refresh_token if API doesn't return a new one
    if "refresh_token" not in new_tokens and "refresh_token" in tokens:
        new_tokens["refresh_token"] = tokens["refresh_token"]

    now = int(time.time())
    new_tokens["expires_at"] = now + int(new_tokens["expires_in"]) - 30

    # keep tenant_id if we already saved it
    if tokens.get("tenant_id"):
        new_tokens["tenant_id"] = tokens["tenant_id"]

    save_tokens(new_tokens)
    return new_tokens


def get_access_token() -> str:
    tokens = load_tokens()
    if token_is_valid(tokens):
        return tokens["access_token"]
    # refresh
    tokens = refresh_access_token(tokens)
    return tokens["access_token"]


def xero_headers() -> dict:
    tenant_id = get_tenant_id()
    if not tenant_id:
        raise Exception(
            "No tenant id set. Go to http://localhost:5000/connections and choose a tenant, "
            "or set XERO_TENANT_ID in your .env."
        )

    access_token = get_access_token()
    return {
        "Authorization": f"Bearer {access_token}",
        "Xero-tenant-id": tenant_id,
        "Accept": "application/json",
    }


def parse_xero_date(xero_date_str: str | None) -> datetime | None:
    """Handles Xero date formats.

    Xero can return:
    - /Date(1719532800000+0000)/
    - ISO-like strings
    """
    if not xero_date_str:
        return None

    if xero_date_str.startswith("/Date("):
        # /Date(1719532800000+0000)/
        try:
            ts = int(xero_date_str.split("(")[1].split("+")[0].split(")")[0])
            return datetime.fromtimestamp(ts / 1000)
        except Exception:
            return None

    try:
        return datetime.fromisoformat(xero_date_str.replace("Z", "+00:00"))
    except Exception:
        return None

# ----------------------------
# CSV mode helpers
# ----------------------------
def _read_exports_csv(filename: str) -> pd.DataFrame:
    fp = EXPORTS_DIR / filename
    if not fp.exists():
        raise FileNotFoundError(f"CSV file not found: {fp}")

    df = pd.read_csv(fp)

    # clean column names
    df.columns = [str(c).strip().replace("\ufeff", "") for c in df.columns]
    return df


def fetch_accounts_csv() -> list[dict]:
    df = _read_exports_csv("Account.csv")
    # return raw rows as dicts (frontend tables can use directly)
    return df.to_dict(orient="records")


def fetch_journals_csv_nested() -> list[dict]:
    """
    Builds Xero-like Journal objects:
    [
      {
        "JournalID": "...",
        "JournalDate": "...",
        "JournalNumber": ...,
        "Reference": "...",
        "JournalLines": [
            {"AccountType": "...", "AccountName": "...", "AccountCode": "...", "GrossAmount": ..., "NetAmount": ...}
        ]
      }
    ]
    """
    journals_df = _read_exports_csv("Journals.csv")
    lines_df = _read_exports_csv("Journal Lines.csv")

    # Parse journal date if present
    if "JOURNAL_DATE" in journals_df.columns:
        journals_df["JOURNAL_DATE"] = pd.to_datetime(journals_df["JOURNAL_DATE"], errors="coerce")

    # Group lines by JOURNAL_ID
    lines_by_journal = {}
    if "JOURNAL_ID" in lines_df.columns:
        for jid, grp in lines_df.groupby("JOURNAL_ID"):
            # Map CSV columns -> Xero-ish keys used by your dashboard code
            mapped_lines = []
            for _, row in grp.iterrows():
                mapped_lines.append(
                    {
                        "AccountType": row.get("ACCOUNT_TYPE"),
                        "AccountName": row.get("ACCOUNT_NAME"),
                        "AccountCode": row.get("ACCOUNT_CODE"),
                        "Description": row.get("DESCRIPTION"),
                        "NetAmount": float(row.get("NET_AMOUNT") or 0),
                        "GrossAmount": float(row.get("GROSS_AMOUNT") or 0),
                        "TaxAmount": float(row.get("TAX_AMOUNT") or 0),
                        "JournalID": row.get("JOURNAL_ID"),
                    }
                )
            lines_by_journal[jid] = mapped_lines

    # Build nested journals
    nested = []
    for _, j in journals_df.iterrows():
        jid = j.get("JOURNAL_ID")
        jdate = j.get("JOURNAL_DATE")
        nested.append(
            {
                "JournalID": jid,
                "JournalNumber": j.get("JOURNAL_NUMBER"),
                "JournalDate": jdate.isoformat() if hasattr(jdate, "isoformat") and pd.notna(jdate) else (j.get("JOURNAL_DATE") or None),
                "CreatedDateUTC": j.get("CREATED_DATE_UTC"),
                "Reference": j.get("REFERENCE"),
                "SourceID": j.get("SOURCE_ID"),
                "SourceType": j.get("SOURCE_TYPE"),
                "JournalLines": lines_by_journal.get(jid, []),
            }
        )

    return nested


def fetch_journal_lines_csv() -> list[dict]:
    df = _read_exports_csv("Journal Lines.csv")
    return df.to_dict(orient="records")

# ----------------------------
# OAuth
# ----------------------------
@app.route("/auth")
def auth():
    """Redirect user to Xero consent screen."""
    if not CLIENT_ID or not CLIENT_SECRET:
        return jsonify({"error": "Missing XERO_CLIENT_ID or XERO_CLIENT_SECRET in .env"}), 500

    auth_url = (
        f"{XERO_AUTHORIZE_URL}?"
        "response_type=code&"
        f"client_id={CLIENT_ID}&"
        f"redirect_uri={urllib.parse.quote(REDIRECT_URI)}&"
        f"scope={urllib.parse.quote(SCOPES)}&"
        "prompt=login"
    )
    return redirect(auth_url)


@app.route("/callback")
def callback():
    """Exchange auth code for tokens and save them."""
    code = request.args.get("code")
    if not code:
        return jsonify({"error": "No authorization code received"}), 400

    token_resp = requests.post(
        XERO_TOKEN_URL,
        data={
            "grant_type": "authorization_code",
            "code": code,
            "redirect_uri": REDIRECT_URI,
        },
        auth=(CLIENT_ID, CLIENT_SECRET),
    )

    if token_resp.status_code != 200:
        return jsonify({"error": "Failed to get tokens", "details": token_resp.text}), 400

    tokens = token_resp.json()
    tokens["expires_at"] = int(time.time()) + int(tokens["expires_in"]) - 30
    save_tokens(tokens)

    # Try to auto-save tenant_id if possible
    try:
        conns = requests.get(
            XERO_CONNECTIONS_URL,
            headers={"Authorization": f"Bearer {tokens['access_token']}"},
        )
        if conns.status_code == 200:
            connections = conns.json()
            if len(connections) == 1:
                tokens["tenant_id"] = connections[0].get("tenantId")
                save_tokens(tokens)
    except Exception:
        pass

    # Close window UX (your original behavior)
    return """
<!DOCTYPE html>
<html>
  <head><title>Authorization Successful</title></head>
  <body style="font-family: Arial, sans-serif; text-align: center; padding: 50px;">
    <h2>✓ Authorization Successful</h2>
    <p>You can close this tab.</p>
    <script>
      setTimeout(() => window.close(), 1500);
    </script>
  </body>
</html>
"""


@app.route("/connections")
def connections():
    """List orgs (tenants) the user connected.

    If you have multiple tenants, pick one by opening:
    /set-tenant?tenantId=XXXX
    """
    tokens = load_tokens()
    if not tokens.get("access_token"):
        return jsonify({"error": "No access token. Authorize first at /auth"}), 401

    # refresh if needed
    if not token_is_valid(tokens):
        tokens = refresh_access_token(tokens)

    resp = requests.get(
        XERO_CONNECTIONS_URL,
        headers={"Authorization": f"Bearer {tokens['access_token']}"},
    )

    if resp.status_code != 200:
        return jsonify({"error": "Failed to get connections", "details": resp.text}), resp.status_code

    connections = resp.json()
    return jsonify(
        {
            "connections": connections,
            "saved_tenant_id": load_tokens().get("tenant_id"),
            "tip": "If you have more than one, call /set-tenant?tenantId=<id> to save it.",
        }
    )


@app.route("/set-tenant")
def set_tenant():
    tenant_id = request.args.get("tenantId")
    if not tenant_id:
        return jsonify({"error": "Missing tenantId"}), 400

    tokens = load_tokens()
    tokens["tenant_id"] = tenant_id
    save_tokens(tokens)
    return jsonify({"ok": True, "tenant_id": tenant_id})


# ----------------------------
# Static files
# ----------------------------


@app.route("/")
def index():
    return app.send_static_file("index.html")




@app.route("/setup")
def setup():
    return send_from_directory(".", "setup.html")


@app.route("/health")
def health():
    tokens = load_tokens()
    now = int(time.time())
    return jsonify(
        {
            "status": "ok",
            "has_client_id": bool(CLIENT_ID),
            "has_client_secret": bool(CLIENT_SECRET),
            "tenant_id": get_tenant_id(),
            "tokens_file_exists": os.path.exists(TOKENS_FILE),
            "has_access_token": bool(tokens.get("access_token")),
            "has_refresh_token": bool(tokens.get("refresh_token")),
            "token_valid": token_is_valid(tokens),
            "token_expires_in": int(tokens.get("expires_at", 0)) - now,
            "note": "If token expired and no refresh_token, go to /auth to re-authorize",
            "data_mode": DATA_MODE,
            "exports_dir": str(EXPORTS_DIR),
        }
    )


# ----------------------------
# Raw Xero passthrough endpoints (unchanged idea)
# ----------------------------
@app.route("/api/invoices")
def api_invoices():
    try:
        resp = requests.get(f"{XERO_API_BASE}/Invoices", headers=xero_headers())
        if resp.status_code != 200:
            return jsonify({"error": f"Xero API error: {resp.status_code}", "details": resp.text}), resp.status_code
        return jsonify(resp.json())
    except Exception as e:
        return jsonify({"error": str(e)}), 500


@app.route("/api/contacts")
def api_contacts():
    try:
        resp = requests.get(f"{XERO_API_BASE}/Contacts", headers=xero_headers())
        if resp.status_code != 200:
            return jsonify({"error": f"Xero API error: {resp.status_code}", "details": resp.text}), resp.status_code
        return jsonify(resp.json())
    except Exception as e:
        return jsonify({"error": str(e)}), 500


@app.route("/api/accounts")
def api_accounts():
    try:
        if DATA_MODE == "csv":
            return jsonify({"Accounts": fetch_accounts_csv()})

        resp = requests.get(f"{XERO_API_BASE}/Accounts", headers=xero_headers())
        if resp.status_code != 200:
            return jsonify({"error": f"Xero API error: {resp.status_code}", "details": resp.text}), resp.status_code
        return jsonify(resp.json())
    except Exception as e:
        return jsonify({"error": str(e)}), 500

@app.route("/api/journals")
def api_journals():
    try:
        if DATA_MODE == "csv":
            return jsonify({"Journals": fetch_journals_csv_nested()})

        resp = requests.get(
            f"{XERO_API_BASE}/Journals",
            headers=xero_headers(),
            params={"offset": 0, "paymentsOnly": "false"},
        )
        if resp.status_code != 200:
            return jsonify({"error": f"Xero API error: {resp.status_code}", "details": resp.text}), resp.status_code
        return jsonify(resp.json())
    except Exception as e:
        return jsonify({"error": str(e)}), 500

@app.route("/api/journal-lines")
def api_journal_lines():
    try:
        if DATA_MODE == "csv":
            return jsonify({"JournalLines": fetch_journal_lines_csv()})
        return jsonify({"error": "JournalLines not implemented in Xero mode in this endpoint"}), 400
    except Exception as e:
        return jsonify({"error": str(e)}), 500

# ----------------------------
# Dashboard endpoints (the main recommendation)
# ----------------------------
def fetch_invoices() -> list[dict]:
    if DATA_MODE == "csv":
        # You don't have invoices CSV yet, so return empty.
        # (Dashboard endpoints that rely on invoices will show empty charts.)
        return []

    resp = requests.get(f"{XERO_API_BASE}/Invoices", headers=xero_headers())
    resp.raise_for_status()
    return resp.json().get("Invoices", [])



def fetch_journals() -> list[dict]:
    if DATA_MODE == "csv":
        return fetch_journals_csv_nested()

    resp = requests.get(
        f"{XERO_API_BASE}/Journals",
        headers=xero_headers(),
        params={"offset": 0, "paymentsOnly": "false"},
    )
    resp.raise_for_status()
    return resp.json().get("Journals", [])

@app.route("/api/dashboard/summary")
def dashboard_summary():
    """Returns simple totals used in your Summary UI."""
    try:
        invoices = fetch_invoices()
        journals = fetch_journals()

        total_sales = sum(float(inv.get("Total") or 0) for inv in invoices)

        # Expense classification similar to your frontend logic
        total_expenses = 0.0
        for j in journals:
            for line in j.get("JournalLines", []) or []:
                account_type = line.get("AccountType")
                account_name = (line.get("AccountName") or "").lower()
                account_code = str(line.get("AccountCode") or "")
                amt = abs(float(line.get("GrossAmount") or line.get("NetAmount") or 0))

                if account_type in ["EXPENSE", "OVERHEADS", "DIRECTCOSTS", "DEPRECIATION"]:
                    total_expenses += amt
                elif account_type == "CURRLIAB" and (
                    "tax" in account_name
                    or "gst" in account_name
                    or "vat" in account_name
                    or "payg" in account_name
                    or (len(account_code) == 3 and account_code.startswith("8") and account_code.isdigit())
                ):
                    total_expenses += amt
                elif account_type in ["CURRLIAB", "EXPENSE"] and (
                    "super" in account_name or "pension" in account_name
                ):
                    total_expenses += amt

        net_profit = total_sales - total_expenses

        return jsonify(
            {
                "total_sales": round(total_sales, 2),
                "total_expenses": round(total_expenses, 2),
                "net_profit": round(net_profit, 2),
                "invoice_count": len(invoices),
            }
        )
    except requests.HTTPError as e:
        return jsonify({"error": "Xero API error", "details": str(e)}), 500
    except Exception as e:
        return jsonify({"error": str(e)}), 500


@app.route("/api/dashboard/sales-by-month")
def dashboard_sales_by_month():
    """Chart.js-ready data: labels + datasets."""
    try:
        invoices = fetch_invoices()

        monthly = {}
        for inv in invoices:
            dt = parse_xero_date(inv.get("Date") or inv.get("DateString"))
            if not dt:
                continue
            key = f"{dt.year}-{dt.month:02d}"
            monthly[key] = monthly.get(key, 0.0) + float(inv.get("Total") or 0)

        labels = sorted(monthly.keys())
        data = [round(monthly[m], 2) for m in labels]

        return jsonify(
            {
                "labels": labels,
                "datasets": [{"label": "Monthly Sales", "data": data}],
            }
        )
    except Exception as e:
        return jsonify({"error": str(e)}), 500


@app.route("/api/dashboard/top-customers")
def dashboard_top_customers():
    try:
        limit = int(request.args.get("limit", "10"))
        invoices = fetch_invoices()

        totals = {}
        for inv in invoices:
            name = ((inv.get("Contact") or {}).get("Name")) or "Unknown"
            totals[name] = totals.get(name, 0.0) + float(inv.get("Total") or 0)

        top = sorted(totals.items(), key=lambda x: x[1], reverse=True)[:limit]
        labels = [name for name, _ in top]
        data = [round(val, 2) for _, val in top]

        return jsonify(
            {
                "labels": labels,
                "datasets": [{"label": f"Top {limit} Customers", "data": data}],
            }
        )
    except Exception as e:
        return jsonify({"error": str(e)}), 500


@app.route("/api/dashboard/sales-by-status")
def dashboard_sales_by_status():
    try:
        invoices = fetch_invoices()

        buckets = {"paid": 0.0, "draft": 0.0, "sent": 0.0, "overdue": 0.0, "other": 0.0}
        for inv in invoices:
            status = str(inv.get("Status") or "").lower()
            amt = float(inv.get("Total") or 0)
            if status in buckets:
                buckets[status] += amt
            else:
                buckets["other"] += amt

        labels = [k.capitalize() for k in buckets.keys()]
        data = [round(v, 2) for v in buckets.values()]

        return jsonify(
            {
                "labels": labels,
                "datasets": [{"label": "Sales by Status", "data": data}],
            }
        )
    except Exception as e:
        return jsonify({"error": str(e)}), 500


@app.route("/api/dashboard/invoice-count-by-status")
def dashboard_invoice_count_by_status():
    try:
        invoices = fetch_invoices()

        buckets = {"paid": 0, "draft": 0, "sent": 0, "overdue": 0, "other": 0}
        for inv in invoices:
            status = str(inv.get("Status") or "").lower()
            if status in buckets:
                buckets[status] += 1
            else:
                buckets["other"] += 1

        labels = [k.capitalize() for k in buckets.keys()]
        data = [int(v) for v in buckets.values()]

        return jsonify(
            {
                "labels": labels,
                "datasets": [{"label": "Invoice Count", "data": data}],
            }
        )
    except Exception as e:
        return jsonify({"error": str(e)}), 500


@app.route("/api/dashboard/budget-monthly")
def dashboard_budget_monthly():
    """Returns the same monthly structure your frontend built, but computed server-side."""
    try:
        journals = fetch_journals()
        monthly = {}

        for j in journals:
            dt = parse_xero_date(j.get("JournalDate") or j.get("JournalDateString"))
            if not dt:
                continue
            key = f"{dt.year}-{dt.month:02d}"

            if key not in monthly:
                monthly[key] = {
                    "month": key,
                    "income": {"revenue": 0.0, "sales": 0.0, "otherIncome": 0.0, "total": 0.0},
                    "expenses": {"operational": 0.0, "taxes": 0.0, "superannuation": 0.0, "total": 0.0},
                    "profit": 0.0,
                }

            for line in j.get("JournalLines", []) or []:
                amount = abs(float(line.get("GrossAmount") or line.get("NetAmount") or 0))
                account_type = line.get("AccountType")
                account_name = (line.get("AccountName") or "").lower()
                account_code = str(line.get("AccountCode") or "")

                # INCOME
                if account_type == "REVENUE":
                    monthly[key]["income"]["revenue"] += amount
                elif account_type == "SALES":
                    monthly[key]["income"]["sales"] += amount
                elif account_type == "OTHERINCOME":
                    monthly[key]["income"]["otherIncome"] += amount

                # EXPENSES
                elif account_type in ["EXPENSE", "OVERHEADS", "DIRECTCOSTS", "DEPRECIATION"]:
                    monthly[key]["expenses"]["operational"] += amount
                elif account_type == "CURRLIAB" and (
                    "tax" in account_name
                    or "gst" in account_name
                    or "vat" in account_name
                    or "payg" in account_name
                    or (len(account_code) == 3 and account_code.startswith("8") and account_code.isdigit())
                ):
                    monthly[key]["expenses"]["taxes"] += amount
                elif account_type in ["CURRLIAB", "EXPENSE"] and (
                    "super" in account_name or "pension" in account_name
                ):
                    monthly[key]["expenses"]["superannuation"] += amount

        # finalize totals
        for key, m in monthly.items():
            m["income"]["total"] = m["income"]["revenue"] + m["income"]["sales"] + m["income"]["otherIncome"]
            m["expenses"]["total"] = m["expenses"]["operational"] + m["expenses"]["taxes"] + m["expenses"]["superannuation"]
            m["profit"] = m["income"]["total"] - m["expenses"]["total"]

        ordered_keys = sorted(monthly.keys())
        monthly_list = [monthly[k] for k in ordered_keys]

        return jsonify({"months": monthly_list})
    except Exception as e:
        return jsonify({"error": str(e)}), 500


@app.route("/api/dashboard/budget-chart")
def dashboard_budget_chart():
    """Chart.js bar chart data: Income vs Expenses by month."""
    try:
        months = dashboard_budget_monthly().get_json().get("months", [])  # reuse
        labels = [m["month"] for m in months]
        income = [round(float(m["income"]["total"]), 2) for m in months]
        expenses = [round(float(m["expenses"]["total"]), 2) for m in months]

        return jsonify(
            {
                "labels": labels,
                "datasets": [
                    {"label": "Income", "data": income},
                    {"label": "Expenses", "data": expenses},
                ],
            }
        )
    except Exception as e:
        return jsonify({"error": str(e)}), 500


@app.route("/api/dashboard/profit-chart")
def dashboard_profit_chart():
    """Chart.js line chart data: profit/loss over time."""
    try:
        months = dashboard_budget_monthly().get_json().get("months", [])
        labels = [m["month"] for m in months]
        profit = [round(float(m["profit"]), 2) for m in months]

        return jsonify(
            {
                "labels": labels,
                "datasets": [{"label": "Profit/Loss", "data": profit}],
            }
        )
    except Exception as e:
        return jsonify({"error": str(e)}), 500


if __name__ == "__main__":
    print("ENV PORT =", os.getenv("PORT"))
    print("ENV DATA_MODE =", os.getenv("DATA_MODE"))

    port = int(os.getenv("PORT", "5000"))
    host = os.getenv("HOST", "127.0.0.1")
    app.run(debug=True, host=host, port=port)

