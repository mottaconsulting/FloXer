from flask import Flask, jsonify, send_from_directory, request, redirect, session, has_request_context, abort
import requests
import os
import time
import urllib.parse
from datetime import datetime, timedelta
from dotenv import load_dotenv
import pandas as pd
from pathlib import Path
import math
import numpy as np
from functools import wraps
from uuid import uuid4
import secrets
import sqlite3
from collections import defaultdict, deque
from threading import Lock
from werkzeug.exceptions import HTTPException
from werkzeug.middleware.proxy_fix import ProxyFix

try:
    import psycopg2
except ModuleNotFoundError:
    psycopg2 = None

load_dotenv()
load_dotenv(Path(os.path.dirname(os.path.dirname(os.path.abspath(__file__)))) / ".env.local", override=True)


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

BASE_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))

MANUAL_BUDGET_FILE = Path(os.getenv("MANUAL_BUDGET_FILE", str(Path(BASE_DIR) / "data" / "manual_budget.csv")))
BUDGET_BACKEND = os.getenv("BUDGET_BACKEND", "supabase").strip().lower()
FRONTEND_DIR = os.path.join(BASE_DIR, "frontend")
APP_ENV = os.getenv("APP_ENV", os.getenv("FLASK_ENV", "development")).strip().lower()
IS_PRODUCTION = APP_ENV == "production"
REDIRECT_URI = os.getenv("XERO_REDIRECT_URI")
PROVISIONAL_LOGIN_EMAIL = os.getenv("PROVISIONAL_LOGIN_EMAIL", "demo@businesspulse.local").strip().lower()
PROVISIONAL_LOGIN_PASSWORD = os.getenv("PROVISIONAL_LOGIN_PASSWORD", "demo123").strip()


def _origin_from_url(url: str) -> str:
    parsed = urllib.parse.urlparse((url or "").strip())
    if not parsed.scheme or not parsed.netloc:
        return ""
    return f"{parsed.scheme.lower()}://{parsed.netloc.lower()}".rstrip("/")


def _is_localhost_url(url: str) -> bool:
    host = urllib.parse.urlparse((url or "").strip()).hostname or ""
    return host in {"localhost", "127.0.0.1"}


def _effective_redirect_uri() -> str:
    configured = (REDIRECT_URI or "").strip()
    if configured:
        if has_request_context():
            req_host = (request.host or "").split(":")[0].lower()
            if _is_localhost_url(configured) and req_host not in {"localhost", "127.0.0.1"}:
                return f"{request.url_root.rstrip('/')}/callback"
        return configured
    # Fallback for environments where XERO_REDIRECT_URI is not injected.
    if has_request_context():
        return f"{request.url_root.rstrip('/')}/callback"
    return ""

app = Flask(__name__, static_folder=FRONTEND_DIR, static_url_path="")
ALLOWED_ORIGINS = os.getenv("ALLOWED_ORIGINS", "").split(",")
_allowed_origins = [o.strip() for o in ALLOWED_ORIGINS if o.strip()]


def _csv_env(name: str, default_csv: str = "") -> list[str]:
    raw = os.getenv(name)
    if raw is None or not raw.strip():
        raw = default_csv
    return [x.strip() for x in raw.split(",") if x.strip()]


_csp_extra_connect_src = _csv_env("CSP_EXTRA_CONNECT_SRC", "")
_csp_extra_script_src = _csv_env("CSP_EXTRA_SCRIPT_SRC", "https://cdn.jsdelivr.net")
_csp_extra_style_src = _csv_env("CSP_EXTRA_STYLE_SRC", "https://fonts.googleapis.com")
_csp_extra_font_src = _csv_env("CSP_EXTRA_FONT_SRC", "https://fonts.gstatic.com")
# Frontend is served by Flask on the same origin in the Render deployment,
# so runtime CORS is intentionally disabled.


def _normalize_csp_source(value: str) -> str:
    origin = _origin_from_url(value)
    return origin or value.strip()


connect_src_values = ["'self'"]
for origin in _allowed_origins:
    src = _normalize_csp_source(origin)
    if src and src not in connect_src_values:
        connect_src_values.append(src)
for src_value in _csp_extra_connect_src:
    src = _normalize_csp_source(src_value)
    if src and src not in connect_src_values:
        connect_src_values.append(src)
_CSP_CONNECT_SRC = " ".join(connect_src_values)
_CSP_SCRIPT_SRC = " ".join(["'self'", "'unsafe-inline'"] + _csp_extra_script_src)
_CSP_STYLE_SRC = " ".join(["'self'", "'unsafe-inline'"] + _csp_extra_style_src)
_CSP_FONT_SRC = " ".join(["'self'", "data:"] + _csp_extra_font_src)

secret_key = os.getenv("FLASK_SECRET_KEY")
if not secret_key or len(secret_key) < 32:
    raise RuntimeError("FLASK_SECRET_KEY must be set and at least 32 characters long.")
app.config["SECRET_KEY"] = secret_key
app.config["SESSION_COOKIE_NAME"] = "xero_dash_session"
app.config["SESSION_COOKIE_SECURE"] = IS_PRODUCTION
app.config["SESSION_COOKIE_HTTPONLY"] = True
app.config["SESSION_COOKIE_SAMESITE"] = "Lax"
app.config["PERMANENT_SESSION_LIFETIME"] = timedelta(hours=8)
app.config["PROPAGATE_EXCEPTIONS"] = False
app.config["TRAP_HTTP_EXCEPTIONS"] = False
app.config["DEBUG"] = False
if IS_PRODUCTION:
    # In production behind Cloudflare Tunnel/reverse proxy, trust one proxy hop
    # so Flask/Werkzeug derive remote/proto/host from validated proxy headers.
    app.wsgi_app = ProxyFix(app.wsgi_app, x_for=1, x_proto=1, x_host=1)

# ----------------------------
# Config
# ----------------------------
CLIENT_ID = os.getenv("XERO_CLIENT_ID")
CLIENT_SECRET = os.getenv("XERO_CLIENT_SECRET")
if not CLIENT_ID or not CLIENT_SECRET:
    raise RuntimeError("XERO_CLIENT_ID and XERO_CLIENT_SECRET must be set in environment.")

# Optional tenant fallback from env.
TENANT_ID_ENV = os.getenv("XERO_TENANT_ID")

# Keep scopes simple: only request what you use.
SCOPES = os.getenv(
    "XERO_SCOPES",
    "accounting.transactions accounting.contacts accounting.settings accounting.journals.read offline_access",
)

XERO_AUTHORIZE_URL = "https://login.xero.com/identity/connect/authorize"
XERO_TOKEN_URL = "https://identity.xero.com/connect/token"
XERO_CONNECTIONS_URL = "https://api.xero.com/connections"
XERO_API_BASE = "https://api.xero.com/api.xro/2.0"
SUPABASE_DB_URL = os.getenv("SUPABASE_DB_URL", "").strip()
if BUDGET_BACKEND == "supabase":
    if psycopg2 is None:
        raise RuntimeError("psycopg2 is required when BUDGET_BACKEND=supabase. Install dependencies from backend/requirements.txt.")
    if not SUPABASE_DB_URL:
        raise RuntimeError("SUPABASE_DB_URL must be set when BUDGET_BACKEND=supabase.")
DB_FILE = os.getenv("DB_FILE", "app.db")
RATE_LIMIT_WINDOW_SECONDS = int(os.getenv("RATE_LIMIT_WINDOW_SECONDS", "60"))
RATE_LIMIT_MAX_REQUESTS = int(os.getenv("RATE_LIMIT_MAX_REQUESTS", "120"))

_RATE_LIMIT_BUCKETS: dict[str, deque] = defaultdict(deque)
_RATE_LIMIT_LOCK = Lock()
_USER_REFRESH_LOCKS: dict[str, Lock] = defaultdict(Lock)


def login_required(view_func):
    @wraps(view_func)
    def _wrapped(*args, **kwargs):
        if not session.get("user_id"):
            if request.path.startswith("/api/"):
                return jsonify({"error": "Unauthorized", "message": "Login required"}), 401
            return redirect("/login")
        return view_func(*args, **kwargs)

    return _wrapped


@app.before_request
def enforce_rate_limit():
    path = request.path or "/"
    if path.startswith("/static/") or path == "/favicon.ico":
        return None

    # Cloudflare Tunnel forwards the original client IP in CF-Connecting-IP.
    # Fallback to remote_addr (which is corrected by ProxyFix in production).
    client_ip = request.headers.get("CF-Connecting-IP") or request.remote_addr or "unknown"
    now = time.time()

    with _RATE_LIMIT_LOCK:
        bucket = _RATE_LIMIT_BUCKETS[client_ip]
        cutoff = now - RATE_LIMIT_WINDOW_SECONDS
        while bucket and bucket[0] < cutoff:
            bucket.popleft()
        if len(bucket) >= RATE_LIMIT_MAX_REQUESTS:
            if path.startswith("/api/"):
                return jsonify({"error": "Too Many Requests"}), 429
            return ("Too Many Requests", 429)
        bucket.append(now)
    return None


@app.before_request
def csrf_protect_forms():
    session.permanent = True
    if "csrf_token" not in session:
        session["csrf_token"] = secrets.token_urlsafe(32)
    if request.path == "/login":
        return None
    if request.method not in {"POST", "PUT", "PATCH", "DELETE"}:
        return None

    # CSRF requirement applies to browser form submissions.
    if request.mimetype not in {"application/x-www-form-urlencoded", "multipart/form-data"}:
        return None

    sent = request.form.get("_csrf_token") or request.headers.get("X-CSRF-Token")
    if not sent or sent != session.get("csrf_token"):
        abort(403)
    return None


@app.after_request
def add_secure_headers(resp):
    # TODO: remove 'unsafe-inline' from script-src once inline scripts are fully eliminated.
    resp.headers["Content-Security-Policy"] = (
        "default-src 'self'; "
        "img-src 'self' data:; "
        f"style-src {_CSP_STYLE_SRC}; "
        f"script-src {_CSP_SCRIPT_SRC}; "
        f"font-src {_CSP_FONT_SRC}; "
        f"connect-src {_CSP_CONNECT_SRC}; "
        "object-src 'none'; "
        "frame-ancestors 'none'; "
        "base-uri 'self'; "
        "form-action 'self'"
    )
    resp.headers["X-Frame-Options"] = "DENY"
    resp.headers["X-Content-Type-Options"] = "nosniff"
    return resp


# ----------------------------
# DB + token helpers
# ----------------------------
def _db_conn() -> sqlite3.Connection:
    Path(DB_FILE).parent.mkdir(parents=True, exist_ok=True)
    conn = sqlite3.connect(DB_FILE)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA foreign_keys = ON")
    return conn


def init_db() -> None:
    with _db_conn() as conn:
        conn.execute(
            """
            CREATE TABLE IF NOT EXISTS users (
                id TEXT PRIMARY KEY,
                created_at TEXT NOT NULL
            )
            """
        )
        conn.execute(
            """
            CREATE TABLE IF NOT EXISTS xero_tokens (
                user_id TEXT NOT NULL,
                tenant_id TEXT NOT NULL,
                refresh_token TEXT,
                access_token TEXT,
                expires_at INTEGER,
                scope TEXT,
                updated_at TEXT NOT NULL,
                PRIMARY KEY (user_id, tenant_id),
                FOREIGN KEY (user_id) REFERENCES users(id)
            )
            """
        )


def _utc_now_iso() -> str:
    return datetime.utcnow().replace(microsecond=0).isoformat() + "Z"


def ensure_user(user_id: str) -> None:
    with _db_conn() as conn:
        conn.execute(
            "INSERT OR IGNORE INTO users (id, created_at) VALUES (?, ?)",
            (user_id, _utc_now_iso()),
        )


def _find_existing_user_id_for_tenants(tenant_ids: list[str]) -> str | None:
    if not tenant_ids:
        return None
    placeholders = ", ".join("?" for _ in tenant_ids)
    with _db_conn() as conn:
        row = conn.execute(
            f"SELECT user_id FROM xero_tokens WHERE tenant_id IN ({placeholders}) ORDER BY updated_at DESC LIMIT 1",
            tuple(tenant_ids),
        ).fetchone()
    return str(row[0]) if row and row[0] else None


def _persist_tokens_for_tenant(user_id: str, tenant_id: str, tokens: dict) -> None:
    ensure_user(user_id)
    with _db_conn() as conn:
        conn.execute(
            """
            INSERT INTO xero_tokens (user_id, tenant_id, refresh_token, access_token, expires_at, scope, updated_at)
            VALUES (?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT(user_id, tenant_id) DO UPDATE SET
                refresh_token=excluded.refresh_token,
                access_token=excluded.access_token,
                expires_at=excluded.expires_at,
                scope=excluded.scope,
                updated_at=excluded.updated_at
            """,
            (
                user_id,
                tenant_id,
                tokens.get("refresh_token"),
                tokens.get("access_token"),
                int(tokens.get("expires_at") or 0),
                tokens.get("scope"),
                _utc_now_iso(),
            ),
        )


def _persist_tokens_for_tenants(user_id: str, tenant_ids: list[str], tokens: dict) -> None:
    for tenant_id in tenant_ids:
        _persist_tokens_for_tenant(user_id, tenant_id, tokens)


def _selected_tenant() -> str | None:
    if has_request_context():
        return request.args.get("tenant_id") or session.get("tenant_id")
    return None


def _get_user_tenant_ids(user_id: str) -> list[str]:
    with _db_conn() as conn:
        rows = conn.execute(
            "SELECT tenant_id FROM xero_tokens WHERE user_id = ? ORDER BY updated_at DESC",
            (user_id,),
        ).fetchall()
    return [r["tenant_id"] for r in rows if r["tenant_id"]]


def _fetch_and_store_connections(access_token: str, user_id: str, tokens: dict) -> list[str]:
    resp = requests.get(
        XERO_CONNECTIONS_URL,
        headers={"Authorization": f"Bearer {access_token}"},
    )
    resp.raise_for_status()
    connections = resp.json() or []
    tenant_ids = [c.get("tenantId") for c in connections if c.get("tenantId")]
    if tenant_ids:
        _persist_tokens_for_tenants(user_id, tenant_ids, tokens)
    return tenant_ids


def require_tenant_id(access_token: str | None = None) -> str:
    """Return current tenant_id or raise a clear action-oriented error."""
    if not has_request_context() or not session.get("user_id"):
        raise Exception("No authenticated user session. Start OAuth at /auth/start")

    user_id = session["user_id"]
    selected = _selected_tenant()
    tenant_ids = _get_user_tenant_ids(user_id)

    # Fast path: use selected tenant directly from session/request.
    if selected and selected in tenant_ids:
        session["tenant_id"] = selected
        return selected
    if selected and not tenant_ids:
        # tenant missing in DB; fall through to connection refresh
        pass
    elif selected and tenant_ids:
        # selected is stale; use the most recent known tenant without extra network calls.
        session["tenant_id"] = tenant_ids[0]
        return tenant_ids[0]

    # Only call /connections when tenant is missing in session/request OR DB has no tenant rows.
    if not access_token:
        raise Exception("No tenant selected. Open /connections to choose an organization or re-authorize at /auth/start.")
    token_snapshot = load_tokens() or {}
    token_snapshot["access_token"] = access_token
    tenant_ids = _fetch_and_store_connections(access_token, user_id, token_snapshot)
    if not tenant_ids:
        raise Exception("No tenant available. Open /connections to connect an organization or re-authorize at /auth/start.")
    session["tenant_id"] = tenant_ids[0]
    return tenant_ids[0]


def _get_user_token_row(user_id: str, tenant_id: str | None = None) -> dict:
    with _db_conn() as conn:
        if tenant_id:
            row = conn.execute(
                """
                SELECT user_id, tenant_id, refresh_token, access_token, expires_at, scope, updated_at
                FROM xero_tokens
                WHERE user_id = ? AND tenant_id = ?
                """,
                (user_id, tenant_id),
            ).fetchone()
        else:
            row = conn.execute(
                """
                SELECT user_id, tenant_id, refresh_token, access_token, expires_at, scope, updated_at
                FROM xero_tokens
                WHERE user_id = ?
                ORDER BY updated_at DESC
                LIMIT 1
                """,
                (user_id,),
            ).fetchone()
    return dict(row) if row else {}


def load_tokens() -> dict:
    if not has_request_context():
        return {}
    user_id = session.get("user_id")
    if not user_id:
        return {}
    return _get_user_token_row(user_id, _selected_tenant())


def save_tokens(tokens: dict) -> None:
    if not has_request_context():
        return
    user_id = session.get("user_id")
    if not user_id:
        return
    tenant_id = tokens.get("tenant_id") or _selected_tenant()
    if not tenant_id:
        return
    _persist_tokens_for_tenant(user_id, tenant_id, tokens)


def get_tenant_id() -> str | None:
    selected = _selected_tenant()
    if selected:
        return selected
    return TENANT_ID_ENV


def get_active_tenant_id(access_token: str) -> str:
    return require_tenant_id(access_token)


def token_is_valid(tokens: dict) -> bool:
    now = int(time.time())
    return bool(tokens.get("access_token")) and now < int(tokens.get("expires_at", 0))


def refresh_access_token(tokens: dict) -> dict:
    """Refreshes the access token using refresh_token.

    Important: Xero may rotate refresh tokens.
    If the response includes a new refresh_token, you must save it.
    """
    user_id = session.get("user_id") if has_request_context() else "__no_session__"
    lock = _USER_REFRESH_LOCKS[user_id]
    with lock:
        if not tokens.get("refresh_token"):
            raise Exception(
                "Access token expired and no refresh token available. Please re-authorize at /auth/start"
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

        # preserve basic fields
        if tokens.get("scope") and not new_tokens.get("scope"):
            new_tokens["scope"] = tokens["scope"]
        if has_request_context():
            user_id = session.get("user_id")
            if user_id:
                with _db_conn() as conn:
                    tenant_rows = conn.execute(
                        "SELECT tenant_id FROM xero_tokens WHERE user_id = ?",
                        (user_id,),
                    ).fetchall()
                tenant_ids = [r["tenant_id"] for r in tenant_rows]
                new_tokens["expires_at"] = new_tokens["expires_at"]
                _persist_tokens_for_tenants(user_id, tenant_ids, new_tokens)

        return new_tokens


def get_access_token() -> str:
    if not has_request_context() or not session.get("user_id"):
        raise Exception("Unauthorized: no active session user")
    tokens = load_tokens()
    if not tokens:
        raise Exception("No stored tokens for session user/tenant. Re-authorize at /auth/start")
    if token_is_valid(tokens):
        return tokens["access_token"]
    # refresh
    tokens = refresh_access_token(tokens)
    return tokens["access_token"]


def xero_headers() -> dict:
    access_token = get_access_token()
    tenant_id = require_tenant_id(access_token)
    return {
        "Authorization": f"Bearer {access_token}",
        "Xero-tenant-id": tenant_id,
        "Accept": "application/json",
    }


def _json_error(message: str, status: int = 500, details: str | None = None):
    payload = {"error": message}
    if details:
        payload["details"] = details
    return jsonify(payload), status


def _xero_get(resource: str, *, params: dict | None = None) -> requests.Response:
    resource_path = resource.lstrip("/")
    return requests.get(
        f"{XERO_API_BASE}/{resource_path}",
        headers=xero_headers(),
        params=params,
    )


def _xero_passthrough(resource: str):
    try:
        resp = _xero_get(resource)
        if resp.status_code != 200:
            return _json_error(f"Xero API error: {resp.status_code}", resp.status_code, resp.text)
        return jsonify(resp.json())
    except Exception as e:
        return _json_error(str(e))


def _xero_collection(resource: str, root_key: str, *, params: dict | None = None) -> list[dict]:
    resp = _xero_get(resource, params=params)
    resp.raise_for_status()
    return resp.json().get(root_key, []) or []


def _load_live_bank_balance_xero() -> float | None:
    """Return summed live bank account balance from Xero Accounts, if available."""
    try:
        accounts = _xero_collection("Accounts", "Accounts")
    except Exception:
        return None

    total = 0.0
    found = False
    for account in accounts:
        if str(account.get("Type") or "").upper() != "BANK":
            continue
        if str(account.get("Status") or "").upper() not in {"", "ACTIVE"}:
            continue

        bal = account.get("Balance")
        try:
            bal_num = float(bal)
        except (TypeError, ValueError):
            continue
        total += bal_num
        found = True

    return total if found else None


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


init_db()

# ----------------------------
# Legacy CSV helpers (no longer used in runtime mode)
# ----------------------------
def _clean_nan_values(obj):
    """Replace NaN/NaT/Infinity with None so JSON is valid for browsers."""
    if isinstance(obj, dict):
        return {k: _clean_nan_values(v) for k, v in obj.items()}
    if isinstance(obj, list):
        return [_clean_nan_values(v) for v in obj]
    if isinstance(obj, tuple):
        return [_clean_nan_values(v) for v in obj]

    if obj is None:
        return None

    # Handle pandas/numpy NaN/NaT and Python floats
    try:
        if pd.isna(obj):
            return None
    except Exception:
        pass

    if isinstance(obj, float) and not math.isfinite(obj):
        return None

    return obj

def _normalize_col(name: str) -> str:
    s = str(name).strip().replace("\ufeff", "")
    s = s.replace(" ", "_").replace("-", "_")
    s = "".join(ch if ch.isalnum() or ch == "_" else "_" for ch in s)
    while "__" in s:
        s = s.replace("__", "_")
    return s.upper()

def _empty_canonical_df() -> pd.DataFrame:
    df = pd.DataFrame(
        columns=["ACCOUNT_TYPE", "ACCOUNT_NAME", "ACCOUNT_CODE", "DATA_CATEGORY", "JOURNAL_DATE", "NET_AMOUNT"]
    )
    df["JOURNAL_DATE"] = pd.to_datetime(df["JOURNAL_DATE"], errors="coerce")
    df["NET_AMOUNT"] = pd.to_numeric(df["NET_AMOUNT"], errors="coerce")
    return df

def _pick_col(normalized_cols: dict, candidates: list[str]) -> str | None:
    for c in candidates:
        if c in normalized_cols:
            return normalized_cols[c]
    return None

def _normalize_schema(df: pd.DataFrame) -> pd.DataFrame:
    """Normalize input to canonical schema."""
    normalized_cols = {_normalize_col(c): c for c in df.columns}

    col_account_code = _pick_col(
        normalized_cols,
        ["ACCOUNT_CODE", "ACCT_CODE", "CODE"],
    )
    col_account_type = _pick_col(
        normalized_cols,
        ["ACCOUNT_TYPE", "ACCT_TYPE", "TYPE", "ACCOUNTCLASS", "ACCOUNT_CLASS", "DATA_CATEGORY"],
    )
    col_account_name = _pick_col(
        normalized_cols,
        ["ACCOUNT_NAME", "ACCT_NAME", "NAME", "ACCOUNT"],
    )
    col_data_category = _pick_col(
        normalized_cols,
        ["DATA_CATEGORY", "CATEGORY", "CATEGORY_NAME", "DATA_CAT", "ACCOUNT_CATEGORY"],
    )
    col_journal_date = _pick_col(
        normalized_cols,
        ["JOURNAL_DATE", "DATE", "TRANSACTION_DATE", "POSTED_DATE"],
    )
    col_net_amount = _pick_col(
        normalized_cols,
        ["NET_AMOUNT", "AMOUNT", "VALUE", "NET", "AMT"],
    )

    missing = [k for k, v in {
        "ACCOUNT_NAME": col_account_name,
        "JOURNAL_DATE": col_journal_date,
        "NET_AMOUNT": col_net_amount,
    }.items() if v is None]
    if missing:
        raise ValueError(f"Missing required columns: {', '.join(missing)}")

    raw_dates = df[col_journal_date]
    try:
        parsed_dates = pd.to_datetime(raw_dates, errors="coerce", dayfirst=True, format="mixed")
        if parsed_dates.isna().any():
            alt = pd.to_datetime(raw_dates, errors="coerce", dayfirst=False, format="mixed")
            parsed_dates = parsed_dates.fillna(alt)
    except Exception:
        parsed_dates = pd.to_datetime(raw_dates, errors="coerce", dayfirst=True)
        if parsed_dates.isna().any():
            alt = pd.to_datetime(raw_dates, errors="coerce", dayfirst=False)
            parsed_dates = parsed_dates.fillna(alt)

    out = pd.DataFrame(
        {
            "ACCOUNT_TYPE": df[col_account_type].astype(str).str.strip().str.upper() if col_account_type else "",
            "ACCOUNT_NAME": df[col_account_name].astype(str).str.strip(),
            "ACCOUNT_CODE": df[col_account_code].astype(str).str.strip() if col_account_code else "",
            "DATA_CATEGORY": df[col_data_category].astype(str).str.strip() if col_data_category else "",
            "JOURNAL_DATE": parsed_dates,
            "NET_AMOUNT": pd.to_numeric(df[col_net_amount], errors="coerce"),
        }
    )

    if col_account_type is None:
        if col_data_category:
            out["ACCOUNT_TYPE"] = out["DATA_CATEGORY"].astype(str).str.strip().str.upper()
        else:
            out["ACCOUNT_TYPE"] = ""

    out = out.dropna(subset=["JOURNAL_DATE"])
    return out

def _enforce_sign_convention(df: pd.DataFrame) -> pd.DataFrame:
    """Ensure REVENUE is negative and EXPENSE is positive."""
    df = df.copy()
    if "ACCOUNT_TYPE" not in df.columns:
        return df
    is_revenue = df["ACCOUNT_TYPE"] == "REVENUE"
    is_expense = df["ACCOUNT_TYPE"] == "EXPENSE"
    if is_revenue.any():
        rev = pd.to_numeric(df.loc[is_revenue, "NET_AMOUNT"], errors="coerce")
        if (rev >= 0).all():
            df.loc[is_revenue, "NET_AMOUNT"] = -rev.abs()
    if is_expense.any():
        exp = pd.to_numeric(df.loc[is_expense, "NET_AMOUNT"], errors="coerce")
        if (exp <= 0).all():
            df.loc[is_expense, "NET_AMOUNT"] = exp.abs()
    return df

def _load_budget_df_manual() -> pd.DataFrame:
    if not MANUAL_BUDGET_FILE.exists():
        return _empty_canonical_df()
    df = pd.read_csv(MANUAL_BUDGET_FILE)
    df.columns = [_normalize_col(c) for c in df.columns]
    budget = _normalize_schema(df)
    budget = _enforce_sign_convention(budget)
    if "DATA_CATEGORY" in budget.columns:
        budget["DATA_CATEGORY"] = budget["DATA_CATEGORY"].replace("", "Budget")
    return budget

def _save_budget_rows_manual(rows: list[dict]) -> pd.DataFrame:
    incoming = pd.DataFrame(rows or [])
    if incoming.empty:
        clean = _empty_canonical_df()
    else:
        incoming.columns = [_normalize_col(c) for c in incoming.columns]
        clean = _normalize_schema(incoming)
        clean = _enforce_sign_convention(clean)
        if "DATA_CATEGORY" in clean.columns:
            clean["DATA_CATEGORY"] = clean["DATA_CATEGORY"].replace("", "Budget")
        else:
            clean["DATA_CATEGORY"] = "Budget"

    MANUAL_BUDGET_FILE.parent.mkdir(parents=True, exist_ok=True)
    out = clean.copy()
    if "JOURNAL_DATE" in out.columns:
        out["JOURNAL_DATE"] = pd.to_datetime(out["JOURNAL_DATE"], errors="coerce").dt.strftime("%Y-%m-%d")
    out.to_csv(MANUAL_BUDGET_FILE, index=False)
    return clean


def _supabase_budget_conn():
    if psycopg2 is None:
        raise RuntimeError("psycopg2 is not installed. Switch to BUDGET_BACKEND=manual for local CSV budget storage, or install backend requirements.")
    if not SUPABASE_DB_URL:
        raise RuntimeError("SUPABASE_DB_URL must be set when BUDGET_BACKEND=supabase.")
    return psycopg2.connect(SUPABASE_DB_URL)


def _ensure_supabase_budget_table() -> None:
    with _supabase_budget_conn() as conn:
        with conn.cursor() as cur:
            cur.execute(
                """
                CREATE TABLE IF NOT EXISTS manual_budget (
                    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
                    user_id TEXT NOT NULL,
                    journal_date DATE NOT NULL,
                    account_type TEXT NOT NULL,
                    account_name TEXT NOT NULL,
                    net_amount NUMERIC NOT NULL,
                    data_category TEXT NOT NULL DEFAULT 'Budget',
                    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
                    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
                )
                """
            )
        conn.commit()


def _budget_session_user_id() -> str:
    user_id = session.get("user_id") if has_request_context() else None
    if not user_id:
        raise RuntimeError("Login required before accessing Supabase budget storage.")
    return str(user_id)


def _load_budget_df_supabase() -> pd.DataFrame:
    _ensure_supabase_budget_table()
    user_id = _budget_session_user_id()
    with _supabase_budget_conn() as conn:
        with conn.cursor() as cur:
            cur.execute(
                """
                SELECT
                    account_type AS ACCOUNT_TYPE,
                    account_name AS ACCOUNT_NAME,
                    '' AS ACCOUNT_CODE,
                    COALESCE(data_category, 'Budget') AS DATA_CATEGORY,
                    journal_date AS JOURNAL_DATE,
                    net_amount AS NET_AMOUNT
                FROM manual_budget
                WHERE user_id = %s
                ORDER BY journal_date, account_type, account_name
                """,
                (user_id,),
            )
            rows = cur.fetchall()
            cols = [desc[0] for desc in cur.description] if cur.description else []
    if not rows:
        return _empty_canonical_df()
    df = pd.DataFrame(rows, columns=cols)
    df.columns = [_normalize_col(c) for c in df.columns]
    budget = _normalize_schema(df)
    budget = _enforce_sign_convention(budget)
    if "DATA_CATEGORY" in budget.columns:
        budget["DATA_CATEGORY"] = budget["DATA_CATEGORY"].replace("", "Budget")
    return budget


def _save_budget_rows_supabase(rows: list[dict]) -> pd.DataFrame:
    incoming = pd.DataFrame(rows or [])
    if incoming.empty:
        clean = _empty_canonical_df()
    else:
        incoming.columns = [_normalize_col(c) for c in incoming.columns]
        clean = _normalize_schema(incoming)
        clean = _enforce_sign_convention(clean)
        if "DATA_CATEGORY" in clean.columns:
            clean["DATA_CATEGORY"] = clean["DATA_CATEGORY"].replace("", "Budget")
        else:
            clean["DATA_CATEGORY"] = "Budget"

    _ensure_supabase_budget_table()
    user_id = _budget_session_user_id()
    with _supabase_budget_conn() as conn:
        with conn.cursor() as cur:
            cur.execute("DELETE FROM manual_budget WHERE user_id = %s", (user_id,))
            if not clean.empty:
                payload = clean.copy()
                payload["JOURNAL_DATE"] = pd.to_datetime(payload["JOURNAL_DATE"], errors="coerce").dt.date
                records = [
                    (
                        user_id,
                        row["JOURNAL_DATE"],
                        str(row.get("ACCOUNT_TYPE") or ""),
                        str(row.get("ACCOUNT_NAME") or ""),
                        float(row.get("NET_AMOUNT") or 0),
                        str(row.get("DATA_CATEGORY") or "Budget"),
                    )
                    for _, row in payload.iterrows()
                    if pd.notna(row.get("JOURNAL_DATE"))
                ]
                if records:
                    cur.executemany(
                        """
                        INSERT INTO manual_budget
                            (user_id, journal_date, account_type, account_name, net_amount, data_category)
                        VALUES (%s, %s, %s, %s, %s, %s)
                        """,
                        records,
                    )
        conn.commit()
    return clean

def _load_actuals_df_xero() -> pd.DataFrame:
    journals = fetch_journals()
    rows = []
    for j in journals:
        jdate = parse_xero_date(j.get("JournalDate") or j.get("JournalDateString"))
        if not jdate:
            continue
        lines = j.get("JournalLines", []) or []
        for line in lines:
            rows.append(
                {
                    "ACCOUNT_TYPE": str(line.get("AccountType") or "").strip().upper(),
                    "ACCOUNT_NAME": str(line.get("AccountName") or "").strip(),
                    "ACCOUNT_CODE": str(line.get("AccountCode") or "").strip(),
                    "DATA_CATEGORY": "Actual",
                    "JOURNAL_DATE": jdate,
                    "NET_AMOUNT": float(line.get("NetAmount") or line.get("GrossAmount") or 0.0),
                }
            )
    if not rows:
        return _empty_canonical_df()
    df = pd.DataFrame(rows)
    df["JOURNAL_DATE"] = pd.to_datetime(df["JOURNAL_DATE"], errors="coerce")
    df["NET_AMOUNT"] = pd.to_numeric(df["NET_AMOUNT"], errors="coerce")
    df = df.dropna(subset=["JOURNAL_DATE"])
    return _enforce_sign_convention(df)

def _load_budget_df_active() -> pd.DataFrame:
    """Load budget data from Supabase (PostgreSQL) only."""
    try:
        return _load_budget_df_supabase()
    except Exception as e:
        # Log error but return empty DF instead of crashing
        print(f"Warning: Failed to load budget from Supabase: {e}")
        return _empty_canonical_df()

def _load_liability_lines_df_xero() -> pd.DataFrame:
    actuals = _load_actuals_df_xero()
    if actuals.empty:
        return actuals
    if "ACCOUNT_CODE" not in actuals.columns:
        actuals["ACCOUNT_CODE"] = ""
    if "ACCOUNT_NAME" not in actuals.columns:
        actuals["ACCOUNT_NAME"] = ""
    return actuals[actuals["ACCOUNT_TYPE"] == "CURRLIAB"].copy()



# ----------------------------
# Forecast helpers
# ----------------------------
def _fy_bounds(today: datetime, fy_start_month: int) -> tuple[datetime, datetime]:
    if fy_start_month < 1 or fy_start_month > 12:
        raise ValueError("fy_start_month must be between 1 and 12")
    start_year = today.year - 1 if today.month < fy_start_month else today.year
    fy_start = datetime(start_year, fy_start_month, 1)
    fy_end = (pd.Timestamp(fy_start) + pd.DateOffset(months=12) - pd.Timedelta(days=1)).to_pydatetime()
    return fy_start, fy_end


def _month_range(fy_start: datetime, fy_end: datetime) -> list[datetime]:
    return [d.to_pydatetime() for d in pd.date_range(fy_start, fy_end, freq="MS")]


def _fy_quarter_bounds(date: datetime, fy_start_month: int) -> tuple[datetime, datetime]:
    if fy_start_month < 1 or fy_start_month > 12:
        raise ValueError("fy_start_month must be between 1 and 12")
    fy_year = date.year if date.month >= fy_start_month else date.year - 1
    months_since_fy = (date.month - fy_start_month) % 12
    quarter_index = months_since_fy // 3
    start_month = ((fy_start_month - 1 + quarter_index * 3) % 12) + 1
    start_year = fy_year if start_month >= fy_start_month else fy_year + 1
    q_start = datetime(start_year, start_month, 1)
    q_end = (pd.Timestamp(q_start) + pd.DateOffset(months=3) - pd.Timedelta(days=1)).to_pydatetime()
    return q_start, q_end


def _period_bounds(date: datetime, period: str, fy_start_month: int) -> tuple[datetime, datetime]:
    if period == "month":
        start = datetime(date.year, date.month, 1)
        end = (pd.Timestamp(start) + pd.DateOffset(months=1) - pd.Timedelta(days=1)).to_pydatetime()
        return start, end
    if period == "quarter":
        return _fy_quarter_bounds(date, fy_start_month)
    raise ValueError("period must be 'month' or 'quarter'")


def _next_business_day_if_weekend(d: datetime) -> datetime:
    # TODO: extend with AU public holiday calendar support.
    if d.weekday() == 5:
        return d + pd.Timedelta(days=2)
    if d.weekday() == 6:
        return d + pd.Timedelta(days=1)
    return d


def _liability_type(account_code: str, account_name: str) -> str:
    code = str(account_code or "").strip()
    name = str(account_name or "").lower()
    if code.startswith("820") or "gst" in name or "bas" in name:
        return "GST"
    if code.startswith("825") or "payg" in name or "withholding" in name:
        return "PAYG"
    if code.startswith("826") or "super" in name:
        return "SUPER"
    if code.startswith("804") or "wages" in name or "payroll" in name:
        return "WAGES"
    return "OTHER"


def _normalize_frequency(value: str | None, default: str) -> str:
    v = str(value or default).strip().lower()
    return v if v in {"monthly", "quarterly"} else default


def _liability_frequency_config(
    gst_frequency: str | None = None,
    payg_frequency: str | None = None,
    super_frequency: str | None = None,
) -> dict:
    return {
        "GST": _normalize_frequency(gst_frequency, _normalize_frequency(os.getenv("GST_FREQUENCY"), "monthly")),
        "PAYG": _normalize_frequency(payg_frequency, _normalize_frequency(os.getenv("PAYG_FREQUENCY"), "monthly")),
        "SUPER": _normalize_frequency(super_frequency, _normalize_frequency(os.getenv("SUPER_FREQUENCY"), "quarterly")),
        "WAGES": "payrun",
    }


def _expected_due_date(
    liability_type: str,
    period_end: datetime,
    frequency_map: dict,
) -> tuple[datetime | None, str | None]:
    payg_monthly_due_day = int(os.getenv("PAYG_MONTHLY_DUE_DAY", "21"))
    if liability_type == "GST":
        freq = frequency_map.get("GST", "monthly")
        if freq == "monthly":
            next_month = pd.Timestamp(period_end) + pd.DateOffset(months=1)
            due = datetime(next_month.year, next_month.month, 21)
            return _next_business_day_if_weekend(due), "GST monthly: 21st next month"
        else:
            due = period_end + pd.Timedelta(days=28)
            return _next_business_day_if_weekend(due), "GST quarterly: 28 days after quarter end"

    if liability_type == "SUPER":
        due = period_end + pd.Timedelta(days=28)
        return _next_business_day_if_weekend(due), "SG: 28 days after quarter end"

    if liability_type == "PAYG":
        freq = frequency_map.get("PAYG", "monthly")
        if freq == "quarterly":
            due = period_end + pd.Timedelta(days=28)
            return _next_business_day_if_weekend(due), "PAYG quarterly: 28 days after quarter end"
        next_month = pd.Timestamp(period_end) + pd.DateOffset(months=1)
        due = datetime(next_month.year, next_month.month, payg_monthly_due_day)
        return _next_business_day_if_weekend(due), f"PAYG monthly: {payg_monthly_due_day}th next month"

    return None, None


def complete_budget_to_fy(
    budget_df: pd.DataFrame, fy_start: datetime, fy_end: datetime
) -> tuple[pd.DataFrame, int]:
    """Fill missing months using mean of latest 3 available months per (ACCOUNT_TYPE, ACCOUNT_NAME)."""
    if "ACCOUNT_TYPE" not in budget_df.columns:
        budget_df = budget_df.copy()
        budget_df["ACCOUNT_TYPE"] = ""
    if "ACCOUNT_NAME" not in budget_df.columns:
        budget_df = budget_df.copy()
        budget_df["ACCOUNT_NAME"] = ""
    months = _month_range(fy_start, fy_end)
    budget_df = budget_df.copy()
    budget_df["MONTH"] = budget_df["JOURNAL_DATE"].dt.to_period("M").dt.to_timestamp()

    rows = []
    filled_count = 0

    for (acct_type, acct_name), grp in budget_df.groupby(["ACCOUNT_TYPE", "ACCOUNT_NAME"]):
        grp_monthly = grp.groupby("MONTH")["NET_AMOUNT"].sum().sort_index()
        latest_vals = grp_monthly.tail(3).values
        fill_value = float(np.mean(latest_vals)) if len(latest_vals) else 0.0

        for m in months:
            if m in grp_monthly.index:
                val = float(grp_monthly.loc[m])
            else:
                val = float(fill_value)
                filled_count += 1

            rows.append(
                {
                    "ACCOUNT_TYPE": acct_type,
                    "ACCOUNT_NAME": acct_name,
                    "DATA_CATEGORY": "",
                    "JOURNAL_DATE": m,
                    "NET_AMOUNT": val,
                }
            )

    completed = pd.DataFrame(rows)
    completed = _enforce_sign_convention(completed)
    return completed, filled_count


def _calc_revenue_expense(df: pd.DataFrame) -> tuple[float, float]:
    if "ACCOUNT_TYPE" not in df.columns or "NET_AMOUNT" not in df.columns:
        return 0.0, 0.0
    revenue_value = -df.loc[df["ACCOUNT_TYPE"] == "REVENUE", "NET_AMOUNT"].sum()
    expense_value = df.loc[df["ACCOUNT_TYPE"] == "EXPENSE", "NET_AMOUNT"].sum()
    return float(revenue_value), float(expense_value)


def _monthly_series(df: pd.DataFrame, months: list[datetime], account_type: str) -> list[float]:
    if "ACCOUNT_TYPE" not in df.columns or "NET_AMOUNT" not in df.columns:
        return [0.0 for _ in months]
    df = df[df["ACCOUNT_TYPE"] == account_type].copy()
    df["MONTH"] = df["JOURNAL_DATE"].dt.to_period("M").dt.to_timestamp()
    monthly = df.groupby("MONTH")["NET_AMOUNT"].sum()
    series = []
    for m in months:
        val = float(monthly.get(pd.Timestamp(m), 0.0))
        if account_type == "REVENUE":
            val = -val
        series.append(val)
    return series


def _build_sales_series(
    actual_df: pd.DataFrame,
    budget_df: pd.DataFrame,
    fy_start: datetime,
    fy_end: datetime,
    today: datetime,
) -> dict:
    months = _month_range(fy_start, fy_end)
    current_month = datetime(today.year, today.month, 1)

    actual_rev = _monthly_series(actual_df, months, "REVENUE")
    budget_rev = _monthly_series(budget_df, months, "REVENUE")

    projected_monthly = []
    for m, actual_val, budget_val in zip(months, actual_rev, budget_rev):
        projected_monthly.append(actual_val if m <= current_month else budget_val)

    actual_cumulative = list(np.cumsum(actual_rev).astype(float))
    projected_cumulative = list(np.cumsum(projected_monthly).astype(float))

    labels = [f"{m.year}-{m.month:02d}" for m in months]
    return {
        "labels": labels,
        "actual_monthly": [round(v, 2) for v in actual_rev],
        "projected_monthly": [round(v, 2) for v in projected_monthly],
        "actual_cumulative": [round(v, 2) for v in actual_cumulative],
        "projected_cumulative": [round(v, 2) for v in projected_cumulative],
    }


def _cumulative_or_none(values: list[float | None]) -> list[float | None]:
    total = 0.0
    out: list[float | None] = []
    for value in values:
        if value is None:
            out.append(None)
            continue
        total += float(value)
        out.append(total)
    return out


def build_forecast_payload(
    today: datetime | None = None,
    fy_start_month: int = 1,
    cash_balance: float | None = None,
    burn_months: int = 3,
) -> dict:
    if today is None:
        today = datetime.today()
    actuals = _load_actuals_df_xero()
    budget = _load_budget_df_active()

    fy_start, fy_end = _fy_bounds(today, fy_start_month)
    actuals_fy = actuals[(actuals["JOURNAL_DATE"] >= fy_start) & (actuals["JOURNAL_DATE"] <= fy_end)]
    budget_fy = budget[(budget["JOURNAL_DATE"] >= fy_start) & (budget["JOURNAL_DATE"] <= fy_end)]

    budget_completed, filled_count = complete_budget_to_fy(budget_fy, fy_start, fy_end)

    current_month = datetime(today.year, today.month, 1)

    actuals_to_date = actuals_fy[actuals_fy["JOURNAL_DATE"] <= today]
    revenue_value, expense_value = _calc_revenue_expense(actuals_to_date)
    profit_now = revenue_value - expense_value

    months = _month_range(fy_start, fy_end)
    actual_profit = [
        r - e
        for r, e in zip(
            _monthly_series(actuals_fy, months, "REVENUE"),
            _monthly_series(actuals_fy, months, "EXPENSE"),
        )
    ]
    budget_profit = [
        r - e
        for r, e in zip(
            _monthly_series(budget_completed, months, "REVENUE"),
            _monthly_series(budget_completed, months, "EXPENSE"),
        )
    ]
    projected_profit = [
        a if m <= current_month else b
        for m, a, b in zip(months, actual_profit, budget_profit)
    ]
    future_profit = float(np.sum(projected_profit))

    # Expenses come from actual journal lines (actuals_fy) and budget for future months.
    actual_expense = _monthly_series(actuals_fy, months, "EXPENSE")
    budget_expense = _monthly_series(budget_completed, months, "EXPENSE")
    projected_expense = [
        a if m <= current_month else b
        for m, a, b in zip(months, actual_expense, budget_expense)
    ]

    expense_series = _monthly_series(actuals_fy, months, "EXPENSE")
    past_expenses = [v for m, v in zip(months, expense_series) if m <= current_month]
    if past_expenses:
        tail = past_expenses[-burn_months:] if burn_months > 0 else past_expenses
        monthly_burn = float(np.mean(tail))
    else:
        monthly_burn = None

    warnings = []
    runway_months = None
    if cash_balance is None:
        warnings.append("Cash balance not provided; runway_months unavailable.")
    elif monthly_burn and monthly_burn > 0:
        runway_months = float(cash_balance) / monthly_burn
    else:
        warnings.append("Insufficient expense history to compute runway.")

    if filled_count:
        warnings.append(f"Budget missing months; filled {filled_count} rows using recent averages.")

    sales_series = _build_sales_series(actuals_fy, budget_completed, fy_start, fy_end, today)
    if not has_budget_projection:
        sales_series["projected_monthly"] = [
            float(v) if m <= current_month else None
            for m, v in zip(months, sales_series["actual_monthly"])
        ]
        sales_series["projected_cumulative"] = [
            float(v) if m <= current_month else None
            for m, v in zip(months, sales_series["actual_cumulative"])
        ]

    payload = {
        "as_of": today.date().isoformat(),
        "fy_start": fy_start.date().isoformat(),
        "fy_end": fy_end.date().isoformat(),
        "kpis": {
            "profit_now": round(float(profit_now), 2),
            "future_profit": round(float(future_profit), 2),
            "runway_months": round(float(runway_months), 2) if runway_months is not None else None,
            "monthly_burn": round(float(monthly_burn), 2) if monthly_burn is not None else None,
        },
        "warnings": warnings,
        "sales": sales_series,
    }

    return _clean_nan_values(payload)


def build_overview_payload(
    today: datetime | None = None,
    fy_start_month: int = 7,
    cash_balance: float | None = None,
    burn_months: int = 3,
    currency: str = "AUD",
) -> dict:
    if today is None:
        today = datetime.today()
    requested_today = today
    actuals = _load_actuals_df_xero()
    budget = _load_budget_df_active()

    fy_start, fy_end = _fy_bounds(today, fy_start_month)
    actuals_fy = actuals[(actuals["JOURNAL_DATE"] >= fy_start) & (actuals["JOURNAL_DATE"] <= fy_end)]
    budget_fy = budget[(budget["JOURNAL_DATE"] >= fy_start) & (budget["JOURNAL_DATE"] <= fy_end)]

    if actuals_fy.empty and len(actuals):
        latest_actual = actuals["JOURNAL_DATE"].max()
        if pd.notna(latest_actual):
            today = latest_actual.to_pydatetime() if hasattr(latest_actual, "to_pydatetime") else latest_actual
            fy_start, fy_end = _fy_bounds(today, fy_start_month)
            actuals_fy = actuals[(actuals["JOURNAL_DATE"] >= fy_start) & (actuals["JOURNAL_DATE"] <= fy_end)]
            budget_fy = budget[(budget["JOURNAL_DATE"] >= fy_start) & (budget["JOURNAL_DATE"] <= fy_end)]

    requested_month = datetime(today.year, today.month, 1)
    latest_actual_dt = None
    if len(actuals_fy):
        latest_actual_fy = actuals_fy["JOURNAL_DATE"].max()
        if pd.notna(latest_actual_fy):
            latest_actual_dt = latest_actual_fy.to_pydatetime() if hasattr(latest_actual_fy, "to_pydatetime") else latest_actual_fy

    anchor_month = requested_month
    if latest_actual_dt is not None:
        latest_actual_month = datetime(latest_actual_dt.year, latest_actual_dt.month, 1)
        if anchor_month > latest_actual_month:
            anchor_month = latest_actual_month
            today = latest_actual_dt
        else:
            month_end_candidate = (pd.Timestamp(anchor_month) + pd.offsets.MonthEnd(0)).to_pydatetime()
            if today < anchor_month:
                today = anchor_month
            if today > month_end_candidate:
                today = month_end_candidate
    else:
        month_end_candidate = (pd.Timestamp(anchor_month) + pd.offsets.MonthEnd(0)).to_pydatetime()
        if today > month_end_candidate:
            today = month_end_candidate

    budget_completed, filled_count = complete_budget_to_fy(budget_fy, fy_start, fy_end)

    current_month = anchor_month
    next_month = (pd.Timestamp(current_month) + pd.DateOffset(months=1)).to_pydatetime()
    previous_month = (pd.Timestamp(current_month) - pd.DateOffset(months=1)).to_pydatetime()

    actuals_to_date = actuals_fy[actuals_fy["JOURNAL_DATE"] < next_month]
    revenue_value, expense_value = _calc_revenue_expense(actuals_to_date)
    profit_now = revenue_value - expense_value

    months = _month_range(fy_start, fy_end)
    actual_profit = [
        r - e
        for r, e in zip(
            _monthly_series(actuals_fy, months, "REVENUE"),
            _monthly_series(actuals_fy, months, "EXPENSE"),
        )
    ]
    actual_profit_to_date = [
        r - e
        for r, e in zip(
            _monthly_series(actuals_to_date, months, "REVENUE"),
            _monthly_series(actuals_to_date, months, "EXPENSE"),
        )
    ]
    prev_fy_start = (pd.Timestamp(fy_start) - pd.DateOffset(years=1)).to_pydatetime()
    prev_fy_end = (pd.Timestamp(fy_end) - pd.DateOffset(years=1)).to_pydatetime()
    prev_next_month = (pd.Timestamp(next_month) - pd.DateOffset(years=1)).to_pydatetime()
    prev_months = _month_range(prev_fy_start, prev_fy_end)
    prev_actuals_to_match = actuals[
        (actuals["JOURNAL_DATE"] >= prev_fy_start) & (actuals["JOURNAL_DATE"] < prev_next_month)
    ]
    previous_year_profit_to_date = [
        r - e
        for r, e in zip(
            _monthly_series(prev_actuals_to_match, prev_months, "REVENUE"),
            _monthly_series(prev_actuals_to_match, prev_months, "EXPENSE"),
        )
    ]
    actual_profit_ytd = float(np.sum(actual_profit_to_date)) if actual_profit_to_date else 0.0
    previous_year_profit_ytd = (
        float(np.sum(previous_year_profit_to_date))
        if previous_year_profit_to_date
        else None
    )
    budget_profit = [
        r - e
        for r, e in zip(
            _monthly_series(budget_completed, months, "REVENUE"),
            _monthly_series(budget_completed, months, "EXPENSE"),
        )
    ]
    has_budget_projection = not budget.empty
    projected_profit = [
        a if m <= current_month else (b if has_budget_projection else None)
        for m, a, b in zip(months, actual_profit, budget_profit)
    ]
    future_profit = float(np.sum([v for v in projected_profit if v is not None])) if has_budget_projection else None
    previous_projected_profit = [
        a if m <= previous_month else (b if has_budget_projection else None)
        for m, a, b in zip(months, actual_profit, budget_profit)
    ]
    future_profit_prev = (
        float(np.sum([v for v in previous_projected_profit if v is not None]))
        if has_budget_projection and months and previous_month >= fy_start
        else None
    )

    previous_month_cutoff = datetime(previous_month.year, previous_month.month, 1)
    previous_next_month = (pd.Timestamp(previous_month_cutoff) + pd.DateOffset(months=1)).to_pydatetime()
    if previous_month_cutoff >= fy_start:
        prior_actuals = actuals_fy[actuals_fy["JOURNAL_DATE"] < previous_next_month]
        prev_rev, prev_exp = _calc_revenue_expense(prior_actuals)
        profit_now_prev = float(prev_rev - prev_exp)
    else:
        profit_now_prev = None

    actual_expense = _monthly_series(actuals_fy, months, "EXPENSE")
    actual_revenue = _monthly_series(actuals_fy, months, "REVENUE")
    budget_expense = _monthly_series(budget_completed, months, "EXPENSE")
    projected_expense = [
        a if m <= current_month else (b if has_budget_projection else None)
        for m, a, b in zip(months, actual_expense, budget_expense)
    ]

    sales_series = _build_sales_series(actuals_fy, budget_completed, fy_start, fy_end, today)
    available_months = []
    if "JOURNAL_DATE" in actuals_fy.columns and len(actuals_fy):
        months_set = {
            datetime(d.year, d.month, 1)
            for d in pd.to_datetime(actuals_fy["JOURNAL_DATE"], errors="coerce").dropna().tolist()
        }
        available_months = [f"{m.year}-{m.month:02d}" for m in sorted(months_set)]

    available_fy_end_years = []
    date_pool = []
    if "JOURNAL_DATE" in actuals.columns and len(actuals):
        date_pool.extend(pd.to_datetime(actuals["JOURNAL_DATE"], errors="coerce").dropna().tolist())
    if "JOURNAL_DATE" in budget.columns and len(budget):
        date_pool.extend(pd.to_datetime(budget["JOURNAL_DATE"], errors="coerce").dropna().tolist())
    if date_pool:
        fy_years = {
            (d.year + 1) if d.month >= fy_start_month else d.year
            for d in date_pool
        }
        available_fy_end_years = sorted(fy_years)

    month_actuals = actuals_fy[
        (actuals_fy["JOURNAL_DATE"] >= current_month) & (actuals_fy["JOURNAL_DATE"] < next_month)
    ]
    if len(month_actuals):
        month_rev, month_exp = _calc_revenue_expense(month_actuals)
    else:
        month_rev, month_exp = None, None

    bank_rows = actuals_fy[
        (actuals_fy["ACCOUNT_TYPE"] == "BANK")
        & (actuals_fy["JOURNAL_DATE"] < next_month)
    ].copy()
    # Cashflow chart is aligned to P&L monthly net movement for consistency:
    # net = revenue - expense, split into in/out bars.
    cashflow_cash_in = []
    cashflow_cash_out = []
    for m, revenue_m, expense_m in zip(months, actual_revenue, actual_expense):
        if m > current_month:
            cashflow_cash_in.append(0.0)
            cashflow_cash_out.append(0.0)
            continue
        net_m = float(revenue_m) - float(expense_m)
        cashflow_cash_in.append(max(0.0, net_m))
        cashflow_cash_out.append(max(0.0, -net_m))

    bank_burn_series: list[float] = []
    if len(bank_rows):
        bank_rows["MONTH"] = bank_rows["JOURNAL_DATE"].dt.to_period("M").dt.to_timestamp()
        # Keep sign convention aligned with frontend and KPI math:
        # positive NET_AMOUNT = cash in, negative NET_AMOUNT = cash out.
        bank_in = bank_rows.loc[bank_rows["NET_AMOUNT"] > 0].groupby("MONTH")["NET_AMOUNT"].sum()
        bank_out = bank_rows.loc[bank_rows["NET_AMOUNT"] < 0].groupby("MONTH")["NET_AMOUNT"].sum().abs()
        for idx, m in enumerate(months):
            if m > current_month:
                continue
            inflow = float(bank_in.get(pd.Timestamp(m), 0.0))
            outflow = float(bank_out.get(pd.Timestamp(m), 0.0))
            bank_burn_series.append(max(0.0, outflow - inflow))
    if bank_burn_series:
        tail = bank_burn_series[-burn_months:] if burn_months > 0 else bank_burn_series
        monthly_burn = float(np.mean(tail))
    else:
        monthly_burn = None

    live_cash_balance = _load_live_bank_balance_xero()
    effective_cash_balance = (
        float(live_cash_balance)
        if live_cash_balance is not None
        else (float(cash_balance) if cash_balance is not None else None)
    )

    warnings = []
    runway_months = None
    if latest_actual_dt is not None and requested_month > datetime(latest_actual_dt.year, latest_actual_dt.month, 1):
        warnings.append(
            f"Selected month is beyond available actuals; using {latest_actual_dt.year}-{latest_actual_dt.month:02d} as the latest actual month."
        )
    if effective_cash_balance is None:
        warnings.append("Cash balance not available; runway_months unavailable.")
    elif monthly_burn and monthly_burn > 0:
        runway_months = float(effective_cash_balance) / monthly_burn
    else:
        warnings.append("Insufficient bank history to compute runway.")

    if filled_count:
        warnings.append(f"Budget missing months; filled {filled_count} rows using recent averages.")
    if budget.empty:
        warnings.append("No manual budget yet. Future Profit is unavailable until budget rows are added.")

    current_liabilities = None
    if "ACCOUNT_TYPE" in actuals_to_date.columns and "NET_AMOUNT" in actuals_to_date.columns:
        cur_df = actuals_to_date.loc[actuals_to_date["ACCOUNT_TYPE"] == "CURRLIAB"].copy()
        if len(cur_df):
            if "ACCOUNT_CODE" in cur_df.columns:
                key_series = cur_df["ACCOUNT_CODE"].fillna("")
            elif "ACCOUNT_NAME" in cur_df.columns:
                key_series = cur_df["ACCOUNT_NAME"].fillna("")
            else:
                key_series = pd.Series(["CURRLIAB"] * len(cur_df), index=cur_df.index)
            cur_df["_LIAB_KEY"] = key_series.astype(str)
            balances = cur_df.groupby("_LIAB_KEY")["NET_AMOUNT"].sum()
            outstanding = balances[balances < 0].abs()
            if len(outstanding):
                current_liabilities = float(outstanding.sum())

    profit_fy = {
        "labels": sales_series["labels"],
        "actual_monthly_profit": [round(v, 2) for v in actual_profit],
        "actual_ytd_profit": round(actual_profit_ytd, 2),
        "previous_year_monthly_profit": [round(v, 2) for v in previous_year_profit_to_date],
        "previous_year_ytd_profit": (
            round(previous_year_profit_ytd, 2) if previous_year_profit_ytd is not None else None
        ),
        "projected_monthly_profit": [round(v, 2) if v is not None else None for v in projected_profit],
    }
    expenses_fy = {
        "labels": sales_series["labels"],
        "actual_monthly": [round(v, 2) for v in actual_expense],
        "projected_monthly": [round(v, 2) if v is not None else None for v in projected_expense],
        "actual_cumulative": [round(v, 2) for v in list(np.cumsum(actual_expense).astype(float))],
        "projected_cumulative": [round(v, 2) if v is not None else None for v in _cumulative_or_none(projected_expense)],
    }
    cashflow = {
        "labels": sales_series["labels"],
        "cashIn": [round(v, 2) for v in cashflow_cash_in],
        "cashOut": [round(v, 2) for v in cashflow_cash_out],
    }

    payload = {
        "meta": {
            "today": today.date().isoformat(),
            "requested_today": requested_today.date().isoformat(),
            "as_of_month": f"{current_month.year}-{current_month.month:02d}",
            "fy_start": fy_start.date().isoformat(),
            "fy_end": fy_end.date().isoformat(),
            "currency": currency,
            "available_months": available_months,
            "available_fy_end_years": available_fy_end_years,
        },
        "kpis": {
            "profit_now": round(float(profit_now), 2),
            "profit_now_prev": round(float(profit_now_prev), 2) if profit_now_prev is not None else None,
            "future_profit": round(float(future_profit), 2) if future_profit is not None else None,
            "future_profit_prev": round(float(future_profit_prev), 2) if future_profit_prev is not None else None,
            "cash_balance_live": (
                round(float(live_cash_balance), 2) if live_cash_balance is not None else None
            ),
            "cash_balance_proxy": (
                round(float(effective_cash_balance), 2) if effective_cash_balance is not None else None
            ),
            "runway_months": round(float(runway_months), 2) if runway_months is not None else None,
            "monthly_burn": round(float(monthly_burn), 2) if monthly_burn is not None else None,
            "monthly_burn_basis": "bank_net_outflow_3m",
            "sales_this_month": round(float(month_rev), 2) if month_rev is not None else None,
            "spending_this_month": round(float(month_exp), 2) if month_exp is not None else None,
            "current_liabilities": round(float(current_liabilities), 2) if current_liabilities is not None else None,
            "warnings": warnings,
        },
        "charts": {
            "cashflow": cashflow,
            "sales_fy": sales_series,
            "profit_fy": profit_fy,
            "expenses_fy": expenses_fy,
        },
    }

    return _clean_nan_values(payload)


def build_liabilities_payload(
    today: datetime | None = None,
    period: str = "month",
    fy_start_month: int = 7,
    gst_frequency: str = "monthly",
    payg_frequency: str | None = None,
    super_frequency: str | None = None,
) -> dict:
    if today is None:
        today = datetime.today()

    lines = _load_liability_lines_df_xero()
    freq_map = _liability_frequency_config(
        gst_frequency=gst_frequency,
        payg_frequency=payg_frequency,
        super_frequency=super_frequency,
    )
    if lines.empty:
        return {
            "meta": {
                "today": today.date().isoformat(),
                "period": period,
                "configuration_used": {
                    "GST_FREQUENCY": freq_map.get("GST"),
                    "PAYG_FREQUENCY": freq_map.get("PAYG"),
                    "SUPER_FREQUENCY": freq_map.get("SUPER"),
                },
                "note": "Agent extensions not included.",
            },
            "rows": [],
        }

    period_start, period_end = _period_bounds(today, period, fy_start_month)
    period_lines = lines[(lines["JOURNAL_DATE"] >= period_start) & (lines["JOURNAL_DATE"] <= period_end)]
    if period_lines.empty:
        latest_date = lines["JOURNAL_DATE"].max()
        if pd.notna(latest_date):
            today = latest_date.to_pydatetime() if hasattr(latest_date, "to_pydatetime") else latest_date
            period_start, period_end = _period_bounds(today, period, fy_start_month)
            period_lines = lines[(lines["JOURNAL_DATE"] >= period_start) & (lines["JOURNAL_DATE"] <= period_end)]

    rows = []
    for (code, name), grp in period_lines.groupby(["ACCOUNT_CODE", "ACCOUNT_NAME"]):
        net = pd.to_numeric(grp["NET_AMOUNT"], errors="coerce").fillna(0.0)
        neg = net[net < 0]
        pos = net[net > 0]

        obligation_created = float(neg.abs().sum())
        amount_paid = float(pos.sum())
        net_position = float(net.sum())
        outstanding_owed = float(abs(net_position)) if net_position < 0 else 0.0
        credit_balance = float(net_position) if net_position > 0 else 0.0

        first_accrual = grp.loc[net < 0, "JOURNAL_DATE"].min()
        last_activity = grp["JOURNAL_DATE"].max()
        last_payment = grp.loc[net > 0, "JOURNAL_DATE"].max()

        ltype = _liability_type(code, name)
        expected_due, basis_rule = _expected_due_date(ltype, period_end, freq_map)
        days_to_due = (expected_due.date() - today.date()).days if expected_due else None

        if credit_balance > 0:
            status = "Credit/Overpaid"
        elif outstanding_owed == 0:
            status = "Paid"
        elif expected_due and today.date() > expected_due.date():
            status = "Overdue"
        elif expected_due and days_to_due is not None and days_to_due <= 14:
            status = "Due soon"
        else:
            status = "Not due"

        rows.append(
            {
                "account_code": code,
                "account_name": name,
                "obligation_created": round(obligation_created, 2),
                "amount_paid": round(amount_paid, 2),
                "outstanding_owed": round(outstanding_owed, 2),
                "credit_balance": round(credit_balance, 2),
                "net_position": round(net_position, 2),
                "outstanding": round(max(outstanding_owed, credit_balance), 2),
                "outstanding_sign": "credit" if credit_balance > 0 else "owed",
                "first_accrual_date": first_accrual.date().isoformat() if pd.notna(first_accrual) else None,
                "last_payment_date": last_payment.date().isoformat() if pd.notna(last_payment) else None,
                "last_activity_date": last_activity.date().isoformat() if pd.notna(last_activity) else None,
                "expected_due_date": expected_due.date().isoformat() if expected_due else None,
                "basis_rule": basis_rule,
                "days_to_due": days_to_due,
                "status": status,
                "configuration_used": {
                    "GST_FREQUENCY": freq_map.get("GST"),
                    "PAYG_FREQUENCY": freq_map.get("PAYG"),
                    "SUPER_FREQUENCY": freq_map.get("SUPER"),
                },
            }
        )

    return _clean_nan_values(
        {
            "meta": {
                "today": today.date().isoformat(),
                "period": period,
                "period_start": period_start.date().isoformat(),
                "period_end": period_end.date().isoformat(),
                "configuration_used": {
                    "GST_FREQUENCY": freq_map.get("GST"),
                    "PAYG_FREQUENCY": freq_map.get("PAYG"),
                    "SUPER_FREQUENCY": freq_map.get("SUPER"),
                },
                "note": "Agent extensions not included.",
            },
            "rows": rows,
        }
    )


def _run_tests() -> None:
    # a) revenue negative converts to positive revenue_value
    df_a = pd.DataFrame(
        {
            "ACCOUNT_TYPE": ["REVENUE", "EXPENSE"],
            "ACCOUNT_NAME": ["Sales", "Rent"],
            "DATA_CATEGORY": ["", ""],
            "JOURNAL_DATE": [datetime(2024, 1, 1), datetime(2024, 1, 2)],
            "NET_AMOUNT": [-100.0, 30.0],
        }
    )
    rev, exp = _calc_revenue_expense(df_a)
    assert rev == 100.0 and exp == 30.0

    # b) complete_budget_to_fy fills missing months
    df_b = pd.DataFrame(
        {
            "ACCOUNT_TYPE": ["REVENUE", "REVENUE"],
            "ACCOUNT_NAME": ["Sales", "Sales"],
            "DATA_CATEGORY": ["", ""],
            "JOURNAL_DATE": [datetime(2024, 1, 1), datetime(2024, 3, 1)],
            "NET_AMOUNT": [-100.0, -120.0],
        }
    )
    fy_start = datetime(2024, 1, 1)
    fy_end = datetime(2024, 3, 31)
    completed, filled = complete_budget_to_fy(df_b, fy_start, fy_end)
    assert len(completed) == 3 and filled >= 1

    # c) sales series arrays match number of FY months
    empty = pd.DataFrame(
        {
            "ACCOUNT_TYPE": pd.Series(dtype=str),
            "ACCOUNT_NAME": pd.Series(dtype=str),
            "DATA_CATEGORY": pd.Series(dtype=str),
            "JOURNAL_DATE": pd.Series(dtype="datetime64[ns]"),
            "NET_AMOUNT": pd.Series(dtype=float),
        }
    )
    fy_start = datetime(2024, 1, 1)
    fy_end = datetime(2024, 12, 31)
    series = _build_sales_series(empty, empty, fy_start, fy_end, datetime(2024, 6, 15))
    assert len(series["labels"]) == 12
    assert len(series["actual_monthly"]) == 12
    assert len(series["projected_monthly"]) == 12


@app.route("/api/debug/config")
def debug_config():
    return jsonify(
        {
            "mode": "xero-with-supabase",
            "note": "This API integrates Xero accounting data with Supabase budget storage.",
            "budget_backend": BUDGET_BACKEND,
            "supabase_url_set": bool(SUPABASE_DB_URL),
        }
    )

# ----------------------------
# OAuth
# ----------------------------

@app.route("/auth/start")
@login_required
def auth_start():
    if not CLIENT_ID or not CLIENT_SECRET:
        return jsonify({"error": "Missing XERO_CLIENT_ID or XERO_CLIENT_SECRET"}), 500
    redirect_uri = _effective_redirect_uri()
    if not redirect_uri:
        return jsonify({"error": "Missing XERO_REDIRECT_URI"}), 500
    if IS_PRODUCTION and (_is_localhost_url(redirect_uri) or not redirect_uri.lower().startswith("https://")):
        return jsonify(
            {
                "error": "Invalid XERO_REDIRECT_URI for production",
                "redirect_uri": redirect_uri,
                "hint": "Set XERO_REDIRECT_URI to your exact Render callback URL (https://.../callback) and register the same URL in the Xero app.",
            }
        ), 500

    state = secrets.token_urlsafe(32)
    session["oauth_state"] = state
    pending_states = list(session.get("oauth_states") or [])
    pending_states.append(state)
    session["oauth_states"] = pending_states[-8:]

    params = {
        "client_id": CLIENT_ID,
        "redirect_uri": redirect_uri,
        "response_type": "code",
        "scope": SCOPES,
        "state": state,
        "prompt": "login",
    }

    query = urllib.parse.urlencode(params)
    auth_url = f"{XERO_AUTHORIZE_URL}?{query}"

    return redirect(auth_url)

@app.route("/auth")
def auth():
    return redirect("/auth/start")


@app.route("/callback")
def callback():
    """Complete OAuth: validate state, exchange code, then create session identity."""
    redirect_uri = _effective_redirect_uri()
    if not redirect_uri:
        return jsonify({"error": "Missing XERO_REDIRECT_URI"}), 500
    if IS_PRODUCTION and (_is_localhost_url(redirect_uri) or not redirect_uri.lower().startswith("https://")):
        return jsonify(
            {
                "error": "Invalid XERO_REDIRECT_URI for production",
                "redirect_uri": redirect_uri,
                "hint": "Set XERO_REDIRECT_URI to your exact Render callback URL (https://.../callback) and register the same URL in the Xero app.",
            }
        ), 500
    expected_state = session.get("oauth_state")
    callback_state = request.args.get("state")
    pending_states = list(session.get("oauth_states") or [])
    state_valid = bool(
        callback_state
        and (
            callback_state == expected_state
            or callback_state in pending_states
        )
    )
    if not state_valid:
        return jsonify(
            {
                "error": "OAuth state validation failed",
                "message": "State mismatch/expired. Start authorization again from /auth/start.",
            }
        ), 403
    # State validated successfully; discard one-time value(s) to prevent replay.
    session.pop("oauth_state", None)
    if callback_state in pending_states:
        pending_states = [s for s in pending_states if s != callback_state]
        session["oauth_states"] = pending_states

    oauth_error = request.args.get("error")
    if oauth_error:
        return jsonify({"error": "OAuth authorization failed", "details": oauth_error}), 400

    code = request.args.get("code")
    if not code:
        return jsonify({"error": "No authorization code received"}), 400

    token_resp = requests.post(
        XERO_TOKEN_URL,
        data={
            "grant_type": "authorization_code",
            "code": code,
            "redirect_uri": redirect_uri,
        },
        auth=(CLIENT_ID, CLIENT_SECRET),
    )

    if token_resp.status_code != 200:
        return jsonify({"error": "Failed to get tokens", "details": token_resp.text}), 400

    raw_tokens = token_resp.json()
    expires_in = int(raw_tokens.get("expires_in", 0))
    tokens = {
        "access_token": raw_tokens.get("access_token"),
        "refresh_token": raw_tokens.get("refresh_token"),
        "expires_in": expires_in,
        "scope": raw_tokens.get("scope"),
        "token_type": raw_tokens.get("token_type"),
        "expires_at": int(time.time()) + expires_in - 30,
    }

    conns_resp = requests.get(
        XERO_CONNECTIONS_URL,
        headers={"Authorization": f"Bearer {tokens['access_token']}"},
    )
    if conns_resp.status_code != 200:
        return jsonify({"error": "Failed to fetch Xero connections", "details": conns_resp.text}), 400

    connections = conns_resp.json() or []
    tenant_ids = [c.get("tenantId") for c in connections if c.get("tenantId")]
    if not tenant_ids:
        return jsonify({"error": "No tenant_id found in Xero connections"}), 400

    # Reuse any existing logical user mapped to these tenants so budgets and tokens remain stable across logins.
    user_id = session.get("user_id") or _find_existing_user_id_for_tenants(tenant_ids) or str(uuid4())
    session["user_id"] = str(user_id)
    session["tenant_id"] = tenant_ids[0]

    # Persist user and tokens only after successful OAuth + tenant resolution.
    ensure_user(str(user_id))
    _persist_tokens_for_tenants(user_id, tenant_ids, tokens)
    return redirect("/dashboard")


@app.route("/auth/logout")
def auth_logout():
    clear_tokens = str(request.args.get("clear_tokens", "false")).lower() in {"1", "true", "yes"}
    user_id = session.get("user_id")
    session.clear()
    if clear_tokens and user_id:
        with _db_conn() as conn:
            conn.execute("DELETE FROM xero_tokens WHERE user_id = ?", (user_id,))
            conn.execute("DELETE FROM users WHERE id = ?", (user_id,))
    return jsonify({"ok": True, "session_cleared": True, "tokens_deleted": bool(clear_tokens and user_id)})


@app.route("/connections")
@login_required
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
    user_id = session.get("user_id")
    tenant_ids = [c.get("tenantId") for c in connections if c.get("tenantId")]
    if user_id and tenant_ids and tokens:
        _persist_tokens_for_tenants(user_id, tenant_ids, tokens)
        if session.get("tenant_id") not in tenant_ids:
            session["tenant_id"] = tenant_ids[0]
    return jsonify(
        {
            "connections": connections,
            "saved_tenant_id": session.get("tenant_id"),
            "tip": "If you have more than one, call /set-tenant?tenantId=<id> to save it.",
        }
    )


@app.route("/set-tenant")
@login_required
def set_tenant():
    tenant_id = request.args.get("tenantId")
    if not tenant_id:
        return jsonify({"error": "Missing tenantId"}), 400

    user_id = session.get("user_id")
    with _db_conn() as conn:
        exists = conn.execute(
            "SELECT 1 FROM xero_tokens WHERE user_id = ? AND tenant_id = ?",
            (user_id, tenant_id),
        ).fetchone()
    if not exists:
        return jsonify({"error": "Tenant not found for current user"}), 404
    session["tenant_id"] = tenant_id
    return jsonify({"ok": True, "tenant_id": tenant_id})


# ----------------------------
# Static files
# ----------------------------


@app.route("/")
def index():
    return redirect("/login")


@app.route("/login", methods=["GET", "POST"])
def login_page():
    if request.method == "POST":
        email = str(request.form.get("email", "")).strip().lower()
        password = str(request.form.get("password", "")).strip()

        if email != PROVISIONAL_LOGIN_EMAIL or password != PROVISIONAL_LOGIN_PASSWORD:
            return redirect("/login?error=invalid")

        user_id = f"local:{email}"
        session["user_id"] = user_id
        ensure_user(user_id)
        return redirect("/dashboard")

    if session.get("user_id"):
        return redirect("/dashboard")
    return app.send_static_file("login.html")


@app.route("/dashboard")
@login_required
def dashboard():
    return app.send_static_file("index.html")


@app.route("/favicon.ico")
def favicon():
    return ("", 204)


@app.errorhandler(HTTPException)
def handle_http_exception(err: HTTPException):
    if request.path.startswith("/api/"):
        return jsonify({"error": err.name}), err.code
    return (err.name, err.code)


@app.errorhandler(Exception)
def handle_unexpected_exception(_err: Exception):
    if request.path.startswith("/api/"):
        return jsonify({"error": "Internal Server Error"}), 500
    return ("Internal Server Error", 500)




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
            "db_file": DB_FILE,
            "has_access_token": bool(tokens.get("access_token")),
            "has_refresh_token": bool(tokens.get("refresh_token")),
            "token_valid": token_is_valid(tokens),
            "token_expires_in": int(tokens.get("expires_at", 0)) - now,
            "note": "If token expired and no refresh_token, go to /auth to re-authorize",
            "data_mode": "xero",
            "budget_backend": BUDGET_BACKEND,
            "manual_budget_file": str(MANUAL_BUDGET_FILE),
        }
    )


# ----------------------------
# Raw Xero passthrough endpoints (unchanged idea)
# ----------------------------
@app.route("/api/invoices")
@login_required
def api_invoices():
    return _xero_passthrough("Invoices")


@app.route("/api/contacts")
@login_required
def api_contacts():
    return _xero_passthrough("Contacts")


@app.route("/api/accounts")
@login_required
def api_accounts():
    return _xero_passthrough("Accounts")

@app.route("/api/journals")
@login_required
def api_journals():
    try:
        journals = fetch_journals()
        return jsonify({"Journals": journals})
    except Exception as e:
        return _json_error(str(e))


@app.route("/api/journal-lines")
@login_required
def api_journal_lines():
    return _json_error("JournalLines passthrough is not supported in Xero mode; use /api/journals", 400)


@app.route("/api/refresh", methods=["POST", "GET"])
@login_required
def api_refresh_token():
    try:
        tokens = load_tokens()
        if not tokens:
            return jsonify({"error": "No stored token for this session user/tenant"}), 401
        refreshed = refresh_access_token(tokens)
        return jsonify(
            {
                "ok": True,
                "tenant_id": get_tenant_id(),
                "expires_at": int(refreshed.get("expires_at", 0)),
            }
        )
    except requests.HTTPError as e:
        status = e.response.status_code if e.response is not None else 500
        return jsonify({"error": f"Token refresh failed: {status}", "details": str(e)}), status
    except Exception as e:
        return jsonify({"error": str(e)}), 500


@app.route("/api/liabilities")
@login_required
def api_liabilities_alias():
    return dashboard_liabilities()


@app.route("/api/budget", methods=["GET", "POST"])
@login_required
def api_budget():
    try:
        budget_source = "supabase:manual_budget" if BUDGET_BACKEND == "supabase" else str(MANUAL_BUDGET_FILE)
        if request.method == "GET":
            budget_df = _load_budget_df_active()
            rows = budget_df.copy()
            if "JOURNAL_DATE" in rows.columns:
                rows["JOURNAL_DATE"] = pd.to_datetime(rows["JOURNAL_DATE"], errors="coerce").dt.strftime("%Y-%m-%d")
            return jsonify(
                {
                    "mode": "xero",
                    "budget_backend": BUDGET_BACKEND,
                    "source": budget_source,
                    "rows": _clean_nan_values(rows.to_dict(orient="records")),
                }
            )

        body = request.get_json(silent=True) or {}
        rows = body.get("rows", [])
        if not isinstance(rows, list):
            return jsonify({"error": "rows must be a list"}), 400

        clean = _save_budget_rows_supabase(rows) if BUDGET_BACKEND == "supabase" else _save_budget_rows_manual(rows)
        out = clean.copy()
        if "JOURNAL_DATE" in out.columns:
            out["JOURNAL_DATE"] = pd.to_datetime(out["JOURNAL_DATE"], errors="coerce").dt.strftime("%Y-%m-%d")
        return jsonify(
            {
                "ok": True,
                "saved_rows": int(len(out)),
                "budget_backend": BUDGET_BACKEND,
                "source": budget_source,
                "rows": _clean_nan_values(out.to_dict(orient="records")),
            }
        )
    except Exception as e:
        return jsonify({"error": str(e)}), 500

# ----------------------------
# Dashboard endpoints (the main recommendation)
# ----------------------------
def fetch_invoices() -> list[dict]:
    return _xero_collection("Invoices", "Invoices")



def fetch_journals() -> list[dict]:
    all_journals: list[dict] = []
    offset = 0
    page_size = 100

    while True:
        batch = _xero_collection(
            "Journals",
            "Journals",
            params={"offset": offset, "paymentsOnly": "false"},
        )
        if not batch:
            break

        all_journals.extend(batch)

        # Xero Journals pagination uses offset; advance by the number received.
        # Stop when the returned page is smaller than the typical page size.
        if len(batch) < page_size:
            break
        offset += len(batch)

    return all_journals

@app.route("/api/dashboard/summary")
@login_required
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


@app.route("/api/dashboard")
@login_required
def dashboard_root():
    """Session-scoped dashboard bootstrap endpoint."""
    try:
        today_str = request.args.get("today")
        fy_start_month = int(request.args.get("fy_start_month", "7"))
        cash_balance = request.args.get("cash_balance")
        burn_months = int(request.args.get("burn_months", "3"))

        today = datetime.fromisoformat(today_str) if today_str else None
        cash_val = float(cash_balance) if cash_balance is not None else None

        payload = build_overview_payload(
            today=today,
            fy_start_month=fy_start_month,
            cash_balance=cash_val,
            burn_months=burn_months,
        )
        return jsonify(payload)
    except requests.HTTPError as e:
        status = e.response.status_code if e.response is not None else 500
        return jsonify({"error": f"Xero API error: {status}", "details": str(e)}), status
    except Exception as e:
        return jsonify({"error": str(e)}), 500


@app.route("/api/dashboard/sales-by-month")
@login_required
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
@login_required
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
@login_required
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
@login_required
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
@login_required
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
@login_required
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
@login_required
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


@app.route("/api/dashboard/forecast")
@login_required
def dashboard_forecast():
    try:
        today_str = request.args.get("today")
        fy_start_month = int(request.args.get("fy_start_month", "1"))
        cash_balance = request.args.get("cash_balance")
        burn_months = int(request.args.get("burn_months", "3"))

        today = datetime.fromisoformat(today_str) if today_str else None
        cash_val = float(cash_balance) if cash_balance is not None else None

        payload = build_forecast_payload(
            today=today,
            fy_start_month=fy_start_month,
            cash_balance=cash_val,
            burn_months=burn_months,
        )
        return jsonify(payload)
    except requests.HTTPError as e:
        status = e.response.status_code if e.response is not None else 500
        return jsonify({"error": f"Xero API error: {status}", "details": str(e)}), status
    except Exception as e:
        return jsonify({"error": str(e)}), 500


@app.route("/api/dashboard/overview")
@login_required
def dashboard_overview():
    try:
        today_str = request.args.get("today")
        fy_start_month = int(request.args.get("fy_start_month", "7"))
        cash_balance = request.args.get("cash_balance")
        burn_months = int(request.args.get("burn_months", "3"))

        today = datetime.fromisoformat(today_str) if today_str else None
        cash_val = float(cash_balance) if cash_balance is not None else None

        payload = build_overview_payload(
            today=today,
            fy_start_month=fy_start_month,
            cash_balance=cash_val,
            burn_months=burn_months,
        )
        return jsonify(payload)
    except requests.HTTPError as e:
        status = e.response.status_code if e.response is not None else 500
        return jsonify({"error": f"Xero API error: {status}", "details": str(e)}), status
    except Exception as e:
        return jsonify({"error": str(e)}), 500


@app.route("/api/dashboard/liabilities")
@login_required
def dashboard_liabilities():
    try:
        today_str = request.args.get("today")
        period = request.args.get("period", "month")
        fy_start_month = int(request.args.get("fy_start_month", "7"))
        gst_frequency = request.args.get("gst_frequency", "monthly")
        payg_frequency = request.args.get("payg_frequency")
        super_frequency = request.args.get("super_frequency")

        today = datetime.fromisoformat(today_str) if today_str else None
        payload = build_liabilities_payload(
            today=today,
            period=period,
            fy_start_month=fy_start_month,
            gst_frequency=gst_frequency,
            payg_frequency=payg_frequency,
            super_frequency=super_frequency,
        )
        return jsonify(payload)
    except requests.HTTPError as e:
        status = e.response.status_code if e.response is not None else 500
        return jsonify({"error": f"Xero API error: {status}", "details": str(e)}), status
    except Exception as e:
        return jsonify({"error": str(e)}), 500


if __name__ == "__main__":
    print("Starting MMXeroAPI backend...")
    print("Environment:", os.getenv("APP_ENV", "development"))
    print("Port:", os.getenv("PORT", "5000"))
    port = int(os.getenv("PORT", 5000))
    app.run(
        host="0.0.0.0",
        port=port,
        debug=False
    )

