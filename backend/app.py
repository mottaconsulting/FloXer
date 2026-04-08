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

import secrets
from collections import defaultdict, deque
from threading import Lock
from werkzeug.exceptions import HTTPException
from werkzeug.middleware.proxy_fix import ProxyFix

try:
    import psycopg2
except ModuleNotFoundError:
    psycopg2 = None

load_dotenv()
_repo_root = Path(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
_env_local_path = _repo_root / ".env.local"
if os.getenv("APP_ENV", os.getenv("FLASK_ENV", "development")).strip().lower() != "production":
    load_dotenv(_env_local_path, override=True)


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

FRONTEND_DIR = os.path.join(BASE_DIR, "frontend")
APP_ENV = os.getenv("APP_ENV", os.getenv("FLASK_ENV", "development")).strip().lower()
IS_PRODUCTION = APP_ENV == "production"
REDIRECT_URI = os.getenv("XERO_REDIRECT_URI")
SUPABASE_URL = os.getenv("SUPABASE_URL", "").strip().rstrip("/")
SUPABASE_ANON_KEY = os.getenv("SUPABASE_ANON_KEY", "").strip()
if not SUPABASE_URL or not SUPABASE_ANON_KEY:
    raise RuntimeError("SUPABASE_URL and SUPABASE_ANON_KEY must be set.")
PRIMARY_BANK_ACCOUNT_CODE = os.getenv("XERO_PRIMARY_BANK_ACCOUNT_CODE", "").strip()
PRIMARY_BANK_ACCOUNT_NAME = os.getenv("XERO_PRIMARY_BANK_ACCOUNT_NAME", "").strip().lower()
PRIMARY_BANK_ACCOUNT_NUMBER = os.getenv("XERO_PRIMARY_BANK_ACCOUNT_NUMBER", "").strip()


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
_csp_extra_script_src = list(dict.fromkeys(["https://cdn.jsdelivr.net"] + _csv_env("CSP_EXTRA_SCRIPT_SRC", "")))
_csp_extra_style_src = list(dict.fromkeys(["https://fonts.googleapis.com"] + _csv_env("CSP_EXTRA_STYLE_SRC", "")))
_csp_extra_font_src = list(dict.fromkeys(["https://fonts.gstatic.com"] + _csv_env("CSP_EXTRA_FONT_SRC", "")))
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
    "accounting.transactions accounting.contacts accounting.settings accounting.journals.read accounting.reports.read offline_access",
)

XERO_AUTHORIZE_URL = "https://login.xero.com/identity/connect/authorize"
XERO_TOKEN_URL = "https://identity.xero.com/connect/token"
XERO_CONNECTIONS_URL = "https://api.xero.com/connections"
XERO_API_BASE = "https://api.xero.com/api.xro/2.0"
SUPABASE_DB_URL = os.getenv("SUPABASE_DB_URL", "").strip()
if psycopg2 is None:
    raise RuntimeError("psycopg2 is required. Install dependencies from backend/requirements.txt.")
if not SUPABASE_DB_URL:
    raise RuntimeError("SUPABASE_DB_URL must be set.")
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
    if request.path in {"/login", "/signup", "/login/forgot", "/login/reset"}:
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
# DB + token helpers (Supabase)
# ----------------------------

def _find_existing_user_id_for_tenants(tenant_ids: list[str]) -> str | None:
    if not tenant_ids:
        return None
    placeholders = ", ".join("%s" for _ in tenant_ids)
    with _supabase_conn() as conn:
        with conn.cursor() as cur:
            cur.execute(
                f"SELECT user_id FROM xero_tokens WHERE tenant_id IN ({placeholders}) ORDER BY updated_at DESC LIMIT 1",
                tuple(tenant_ids),
            )
            row = cur.fetchone()
    return str(row[0]) if row and row[0] else None


def _persist_tokens_for_tenant(user_id: str, tenant_id: str, tokens: dict) -> None:
    with _supabase_conn() as conn:
        with conn.cursor() as cur:
            cur.execute(
                """
                INSERT INTO xero_tokens (user_id, tenant_id, refresh_token, access_token, expires_at, scope, updated_at)
                VALUES (%s, %s, %s, %s, %s, %s, NOW())
                ON CONFLICT (user_id, tenant_id) DO UPDATE SET
                    refresh_token = EXCLUDED.refresh_token,
                    access_token = EXCLUDED.access_token,
                    expires_at = EXCLUDED.expires_at,
                    scope = EXCLUDED.scope,
                    updated_at = NOW()
                """,
                (
                    user_id,
                    tenant_id,
                    tokens.get("refresh_token"),
                    tokens.get("access_token"),
                    int(tokens.get("expires_at") or 0),
                    tokens.get("scope"),
                ),
            )
        conn.commit()


def _persist_tokens_for_tenants(user_id: str, tenant_ids: list[str], tokens: dict) -> None:
    for tenant_id in tenant_ids:
        _persist_tokens_for_tenant(user_id, tenant_id, tokens)


def _selected_tenant() -> str | None:
    if has_request_context():
        return request.args.get("tenant_id") or session.get("tenant_id")
    return None


def _get_user_tenant_ids(user_id: str) -> list[str]:
    with _supabase_conn() as conn:
        with conn.cursor() as cur:
            cur.execute(
                "SELECT tenant_id FROM xero_tokens WHERE user_id = %s ORDER BY updated_at DESC",
                (user_id,),
            )
            rows = cur.fetchall()
    return [r[0] for r in rows if r[0]]


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
    with _supabase_conn() as conn:
        with conn.cursor() as cur:
            if tenant_id:
                cur.execute(
                    """
                    SELECT user_id, tenant_id, refresh_token, access_token, expires_at, scope, updated_at
                    FROM xero_tokens
                    WHERE user_id = %s AND tenant_id = %s
                    """,
                    (user_id, tenant_id),
                )
            else:
                cur.execute(
                    """
                    SELECT user_id, tenant_id, refresh_token, access_token, expires_at, scope, updated_at
                    FROM xero_tokens
                    WHERE user_id = %s
                    ORDER BY updated_at DESC
                    LIMIT 1
                    """,
                    (user_id,),
                )
            row = cur.fetchone()
            cols = [desc[0] for desc in cur.description] if cur.description else []
    return dict(zip(cols, row)) if row else {}


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
                tenant_ids = _get_user_tenant_ids(user_id)
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


def _bank_account_matches(account: dict) -> bool:
    if str(account.get("Type") or "").upper() != "BANK":
        return False
    if str(account.get("Status") or "").upper() not in {"", "ACTIVE"}:
        return False

    if PRIMARY_BANK_ACCOUNT_NUMBER:
        return str(account.get("BankAccountNumber") or "").strip() == PRIMARY_BANK_ACCOUNT_NUMBER
    if PRIMARY_BANK_ACCOUNT_CODE:
        return str(account.get("Code") or "").strip() == PRIMARY_BANK_ACCOUNT_CODE
    if PRIMARY_BANK_ACCOUNT_NAME:
        return str(account.get("Name") or "").strip().lower() == PRIMARY_BANK_ACCOUNT_NAME
    return True


def _filter_bank_rows_for_selected_account(df: pd.DataFrame) -> pd.DataFrame:
    if df is None or df.empty:
        return df
    out = df.copy()
    if PRIMARY_BANK_ACCOUNT_CODE and "ACCOUNT_CODE" in out.columns:
        out = out.loc[out["ACCOUNT_CODE"].fillna("").astype(str).str.strip() == PRIMARY_BANK_ACCOUNT_CODE]
    elif PRIMARY_BANK_ACCOUNT_NAME and "ACCOUNT_NAME" in out.columns:
        out = out.loc[out["ACCOUNT_NAME"].fillna("").astype(str).str.strip().str.lower() == PRIMARY_BANK_ACCOUNT_NAME]
    return out


def _load_live_bank_balance_xero() -> tuple[float | None, str | None]:
    """Return live bank balance from Xero Accounts plus an optional diagnostic.

    If XERO_PRIMARY_BANK_ACCOUNT_NUMBER, XERO_PRIMARY_BANK_ACCOUNT_CODE,
    or XERO_PRIMARY_BANK_ACCOUNT_NAME is set,
    only that bank account is used. Otherwise all active bank accounts are summed.
    """
    try:
        accounts = _xero_collection("Accounts", "Accounts")
    except Exception as exc:
        return None, str(exc)

    total = 0.0
    found = False
    for account in accounts:
        if not _bank_account_matches(account):
            continue

        bal = account.get("Balance")
        try:
            bal_num = float(bal)
        except (TypeError, ValueError):
            continue
        total += bal_num
        found = True

    if found:
        return total, None
    return None, "No active Xero BANK accounts with a readable Balance were found."


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
    """Ensure income is negative and expense-like types are positive."""
    df = df.copy()
    if "ACCOUNT_TYPE" not in df.columns:
        return df
    is_revenue = df["ACCOUNT_TYPE"] == "REVENUE"
    is_expense = df["ACCOUNT_TYPE"].isin(["EXPENSE", "OVERHEADS", "DIRECTCOSTS", "DEPRECIATION"])
    if is_revenue.any():
        rev = pd.to_numeric(df.loc[is_revenue, "NET_AMOUNT"], errors="coerce")
        if (rev >= 0).all():
            df.loc[is_revenue, "NET_AMOUNT"] = -rev.abs()
    if is_expense.any():
        exp = pd.to_numeric(df.loc[is_expense, "NET_AMOUNT"], errors="coerce")
        if (exp <= 0).all():
            df.loc[is_expense, "NET_AMOUNT"] = exp.abs()
    return df



def _supabase_conn():
    return psycopg2.connect(SUPABASE_DB_URL)


def _budget_session_user_id() -> str:
    user_id = session.get("user_id") if has_request_context() else None
    if not user_id:
        raise RuntimeError("Login required before accessing budget storage.")
    return str(user_id)


def _load_budget_df_supabase() -> pd.DataFrame:
    user_id = _budget_session_user_id()
    with _supabase_conn() as conn:
        with conn.cursor() as cur:
            cur.execute(
                """
                SELECT
                    account_type AS ACCOUNT_TYPE,
                    account_name AS ACCOUNT_NAME,
                    COALESCE(account_code, '') AS ACCOUNT_CODE,
                    COALESCE(data_category, 'Budget') AS DATA_CATEGORY,
                    journal_date AS JOURNAL_DATE,
                    net_amount AS NET_AMOUNT
                FROM budget_rows
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

    user_id = _budget_session_user_id()
    with _supabase_conn() as conn:
        with conn.cursor() as cur:
            cur.execute("DELETE FROM budget_rows WHERE user_id = %s", (user_id,))
            if not clean.empty:
                payload = clean.copy()
                payload["JOURNAL_DATE"] = pd.to_datetime(payload["JOURNAL_DATE"], errors="coerce").dt.date
                records = [
                    (
                        user_id,
                        row["JOURNAL_DATE"],
                        str(row.get("ACCOUNT_TYPE") or ""),
                        str(row.get("ACCOUNT_NAME") or ""),
                        str(row.get("ACCOUNT_CODE") or ""),
                        float(row.get("NET_AMOUNT") or 0),
                        str(row.get("DATA_CATEGORY") or "Budget"),
                    )
                    for _, row in payload.iterrows()
                    if pd.notna(row.get("JOURNAL_DATE"))
                ]
                if records:
                    cur.executemany(
                        """
                        INSERT INTO budget_rows
                            (user_id, journal_date, account_type, account_name, account_code, net_amount, data_category)
                        VALUES (%s, %s, %s, %s, %s, %s, %s)
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


def _build_liability_schedule(
    all_lines: "pd.DataFrame",
    today: datetime,
    freq_map: dict,
    period: str = "month",
    fy_start_month: int = 7,
) -> list[dict]:
    """Return upcoming liability payments grouped by expected due month.

    Each entry: {month, name, code, amount, type}
    Only includes accounts with outstanding balance (net negative across all history).
    Overdue items are placed in the current month (pay immediately).
    """
    schedule: list[dict] = []
    if all_lines.empty or "ACCOUNT_TYPE" not in all_lines.columns:
        return schedule

    cur_df = all_lines[all_lines["ACCOUNT_TYPE"] == "CURRLIAB"].copy()
    if cur_df.empty:
        return schedule

    code_col = cur_df["ACCOUNT_CODE"].fillna("").astype(str).str.strip() if "ACCOUNT_CODE" in cur_df.columns else pd.Series("", index=cur_df.index)
    name_col = cur_df["ACCOUNT_NAME"].fillna("").astype(str).str.strip() if "ACCOUNT_NAME" in cur_df.columns else pd.Series("", index=cur_df.index)
    cur_df["_CODE"] = code_col.values
    cur_df["_NAME"] = name_col.values
    cur_df["_KEY"] = code_col.where(code_col != "", name_col).values
    cur_df = cur_df[cur_df["_KEY"] != ""]
    cur_df = cur_df[~cur_df["_NAME"].map(_is_bookkeeping_artefact)]

    for (code, name), grp in cur_df.groupby(["_CODE", "_NAME"]):
        net = pd.to_numeric(grp["NET_AMOUNT"], errors="coerce").fillna(0.0)
        net_position = float(net.sum())
        if net_position >= 0:
            continue
        outstanding = abs(net_position)
        if outstanding < 1.0:
            continue

        last_accrual_ts = grp.loc[net < 0, "JOURNAL_DATE"].max()
        if not pd.notna(last_accrual_ts):
            continue
        last_accrual_dt = last_accrual_ts.to_pydatetime() if hasattr(last_accrual_ts, "to_pydatetime") else last_accrual_ts
        _, accrual_period_end = _period_bounds(last_accrual_dt, period, fy_start_month)

        ltype = _liability_type(code, name)
        expected_due, _ = _expected_due_date(ltype, accrual_period_end, freq_map, last_accrual_dt=last_accrual_dt)

        if expected_due is None or expected_due.date() <= today.date():
            # No due date or already overdue — place in current month
            due_month = f"{today.year}-{today.month:02d}"
        else:
            due_month = f"{expected_due.year}-{expected_due.month:02d}"

        schedule.append({
            "month": due_month,
            "name": name,
            "code": str(code),
            "amount": round(outstanding, 2),
            "type": ltype,
        })

    return schedule


def _is_bookkeeping_artefact(account_name: str) -> bool:
    """Return True for Xero accounts that are bookkeeping artefacts, not real cash liabilities.

    These accounts exist in virtually every Xero file but represent opening-balance
    adjustments, rounding differences, or conversion entries — not money owed to anyone.
    Including them in 'committed cash' produces misleading numbers.
    """
    name = str(account_name or "").lower()
    artefact_patterns = [
        "historical adjustment",
        "opening balance",
        "conversion",
        "rounding",
        "suspense",
        "clearing",
    ]
    return any(p in name for p in artefact_patterns)


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


def _detect_frequency(accrual_dates: "pd.Series") -> str:
    """Infer monthly vs quarterly from the gaps between accrual journal entries.

    Uses the median gap between consecutive accrual dates so that a single
    irregular entry doesn't throw off the result.  Falls back to 'quarterly'
    when there is insufficient history — better to show a later (safer) due
    date than to falsely flag something as overdue.
    """
    dates = pd.to_datetime(accrual_dates, errors="coerce").dropna().sort_values().unique()
    if len(dates) < 2:
        return "quarterly"
    gaps_days = [(dates[i] - dates[i - 1]).days for i in range(1, len(dates))]
    median_gap = sorted(gaps_days)[len(gaps_days) // 2]
    if median_gap < 45:
        return "monthly"
    return "quarterly"


def _liability_frequency_config(
    lines: "pd.DataFrame | None" = None,
    gst_frequency: str | None = None,
    payg_frequency: str | None = None,
    super_frequency: str | None = None,
) -> dict:
    """Build frequency map, auto-detecting from journal history where not overridden.

    Priority: explicit param → env var → auto-detected from journals → quarterly fallback.
    Super is always quarterly (AU Superannuation Guarantee).
    """
    def _resolve(explicit, env_key, detected):
        if explicit:
            return _normalize_frequency(explicit, detected)
        env_val = os.getenv(env_key)
        if env_val:
            return _normalize_frequency(env_val, detected)
        return detected

    detected_gst = "quarterly"
    detected_payg = "quarterly"

    if lines is not None and not lines.empty and "NET_AMOUNT" in lines.columns:
        accruals = lines[pd.to_numeric(lines["NET_AMOUNT"], errors="coerce") < 0]
        for ltype, col in [("GST", "detected_gst"), ("PAYG", "detected_payg")]:
            mask = lines.apply(
                lambda r: _liability_type(
                    str(r.get("ACCOUNT_CODE", "")), str(r.get("ACCOUNT_NAME", ""))
                ) == ltype,
                axis=1,
            )
            subset = accruals[mask]
            if len(subset):
                detected = _detect_frequency(subset["JOURNAL_DATE"])
                if col == "detected_gst":
                    detected_gst = detected
                else:
                    detected_payg = detected

    return {
        "GST": _resolve(gst_frequency, "GST_FREQUENCY", detected_gst),
        "PAYG": _resolve(payg_frequency, "PAYG_FREQUENCY", detected_payg),
        "SUPER": _normalize_frequency(
            super_frequency, _normalize_frequency(os.getenv("SUPER_FREQUENCY"), "quarterly")
        ),
        "WAGES": "payrun",
        "_detected": {"GST": detected_gst, "PAYG": detected_payg},
    }


def _ato_quarter_end(dt: datetime) -> datetime:
    """Return the last day of the ATO quarter containing dt."""
    m = dt.month
    if m in (7, 8, 9):    return datetime(dt.year, 9, 30)
    if m in (10, 11, 12): return datetime(dt.year, 12, 31)
    if m in (1, 2, 3):    return datetime(dt.year, 3, 31)
    return datetime(dt.year, 6, 30)


def _ato_bas_due(quarter_end: datetime) -> datetime:
    """Fixed ATO due date for BAS (GST / PAYG quarterly) from the quarter end date."""
    qm, qy = quarter_end.month, quarter_end.year
    if qm == 9:  return datetime(qy,     10, 28)   # Q1 Jul-Sep  → 28 Oct
    if qm == 12: return datetime(qy + 1,  2, 28)   # Q2 Oct-Dec  → 28 Feb
    if qm == 3:  return datetime(qy,      4, 28)   # Q3 Jan-Mar  → 28 Apr
    return           datetime(qy,          7, 28)   # Q4 Apr-Jun  → 28 Jul


def _ato_super_due(quarter_end: datetime) -> datetime:
    """Fixed ATO due date for Super Guarantee from the quarter end date."""
    qm, qy = quarter_end.month, quarter_end.year
    if qm == 9:  return datetime(qy,     10, 28)   # Q1 → 28 Oct
    if qm == 12: return datetime(qy + 1,  1, 28)   # Q2 → 28 Jan
    if qm == 3:  return datetime(qy,      4, 28)   # Q3 → 28 Apr
    return           datetime(qy,          7, 28)   # Q4 → 28 Jul


def _expected_due_date(
    liability_type: str,
    period_end: datetime,
    frequency_map: dict,
    last_accrual_dt: datetime | None = None,
) -> tuple[datetime | None, str | None]:
    payg_monthly_due_day = int(os.getenv("PAYG_MONTHLY_DUE_DAY", "21"))
    accrual = last_accrual_dt or period_end

    if liability_type == "GST":
        freq = frequency_map.get("GST", "quarterly")
        if freq == "monthly":
            next_month = pd.Timestamp(period_end) + pd.DateOffset(months=1)
            due = datetime(next_month.year, next_month.month, 21)
            return _next_business_day_if_weekend(due), "GST monthly: 21st next month"
        qe = _ato_quarter_end(accrual)
        due = _ato_bas_due(qe)
        return _next_business_day_if_weekend(due), f"GST quarterly: ATO calendar {due.strftime('%d %b %Y')}"

    if liability_type == "SUPER":
        qe = _ato_quarter_end(accrual)
        due = _ato_super_due(qe)
        return _next_business_day_if_weekend(due), f"Super: ATO calendar {due.strftime('%d %b %Y')}"

    if liability_type == "PAYG":
        freq = frequency_map.get("PAYG", "monthly")
        if freq == "quarterly":
            qe = _ato_quarter_end(accrual)
            due = _ato_bas_due(qe)
            return _next_business_day_if_weekend(due), f"PAYG quarterly: ATO calendar {due.strftime('%d %b %Y')}"
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
    expense_value = df.loc[
        df["ACCOUNT_TYPE"].isin(["EXPENSE", "OVERHEADS", "DIRECTCOSTS", "DEPRECIATION"]),
        "NET_AMOUNT",
    ].sum()
    return float(revenue_value), float(expense_value)


def _monthly_series(df: pd.DataFrame, months: list[datetime], account_type: str) -> list[float]:
    if "ACCOUNT_TYPE" not in df.columns or "NET_AMOUNT" not in df.columns:
        return [0.0 for _ in months]
    if account_type == "EXPENSE":
        df = df[df["ACCOUNT_TYPE"].isin(["EXPENSE", "OVERHEADS", "DIRECTCOSTS", "DEPRECIATION"])].copy()
    else:
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


def _fetch_pl_report(fy_start: datetime, fy_end: datetime) -> dict | None:
    """
    Fetch monthly revenue and expense from Xero Reports/ProfitAndLoss API.
    Returns {"revenue": [...], "expense": [...]} aligned to FY months, or None on failure.
    This is more accurate than raw journal lines — GST excluded, matches Xero UI exactly.
    """
    months = _month_range(fy_start, fy_end)
    n = len(months)
    if not n:
        return None
    try:
        resp = _xero_get(
            "Reports/ProfitAndLoss",
            params={
                "fromDate": fy_start.strftime("%Y-%m-%d"),
                "toDate": fy_end.strftime("%Y-%m-%d"),
                "periods": n - 1,
                "timeframe": "MONTH",
                "standardLayout": "true",
            },
        )
        resp.raise_for_status()
        data = resp.json()
    except Exception:
        return None

    report = (data.get("Reports") or [{}])[0]
    rows = report.get("Rows") or []

    # Count data columns from header row
    n_cols = 0
    for row in rows:
        if row.get("RowType") == "Header":
            n_cols = max(0, len(row.get("Cells", [])) - 1)
            break
    if not n_cols:
        return None

    revenue = [0.0] * n_cols
    expense = [0.0] * n_cols

    INCOME_KW  = {"income", "revenue", "sales", "trading"}
    EXPENSE_KW = {"expense", "cost", "overhead", "depreciation"}

    for row in rows:
        if row.get("RowType") != "Section":
            continue
        title = (row.get("Title") or "").strip().lower()
        is_income  = any(k in title for k in INCOME_KW)
        is_expense = (any(k in title for k in EXPENSE_KW) or title.startswith("less")) and not is_income
        if not is_income and not is_expense:
            continue
        for sub in row.get("Rows", []):
            if sub.get("RowType") != "SummaryRow":
                continue
            cells = sub.get("Cells", [])
            for i, cell in enumerate(cells[1: n_cols + 1]):
                try:
                    val = abs(float((cell.get("Value") or "0").replace(",", "")))
                except (ValueError, AttributeError, TypeError):
                    val = 0.0
                if is_income:
                    revenue[i] += val
                elif is_expense:
                    expense[i] += val

    # Pad / truncate to exactly n FY months
    revenue = (revenue + [0.0] * n)[:n]
    expense = (expense + [0.0] * n)[:n]
    return {"revenue": revenue, "expense": expense}


def _fetch_balance_sheet(as_of_date: datetime) -> dict | None:
    """
    Fetch and parse the Xero Balance Sheet report.
    Returns:
      {
        "liabilities": {"total": float, "accounts": [{"name", "amount"}], "xero_total": float},
        "bank":        {"total": float, "accounts": [{"name", "amount"}]},
      }
    or None on failure.
    Liabilities excludes bookkeeping artefacts. Bank preserves signed balances (negative = overdrawn).
    """
    try:
        resp = _xero_get(
            "Reports/BalanceSheet",
            params={"date": as_of_date.strftime("%Y-%m-%d"), "paymentsOnly": "false"},
        )
        resp.raise_for_status()
        data = resp.json()
    except Exception:
        return None

    report = (data.get("Reports") or [{}])[0]
    rows = report.get("Rows") or []

    def _parse_signed(cell: dict) -> float:
        try:
            return float((cell.get("Value") or "0").replace(",", ""))
        except (ValueError, TypeError):
            return 0.0

    def _parse_abs(cell: dict) -> float:
        return abs(_parse_signed(cell))

    # --- Bank section ---
    bank_accounts: list[dict] = []
    bank_total: float | None = None
    for section in rows:
        if section.get("RowType") != "Section":
            continue
        title = (section.get("Title") or "").strip().lower()
        if title != "bank":
            continue
        for row in (section.get("Rows") or []):
            rt = row.get("RowType")
            cells = row.get("Cells") or []
            if rt == "Row" and len(cells) >= 2:
                name = (cells[0].get("Value") or "").strip()
                amount = _parse_signed(cells[1])  # preserve sign: negative = overdrawn
                if name:
                    # Filter to primary bank account if configured
                    name_matches = (not PRIMARY_BANK_ACCOUNT_NAME) or name.lower() == PRIMARY_BANK_ACCOUNT_NAME
                    if name_matches:
                        bank_accounts.append({"name": name, "amount": amount})
            elif rt == "SummaryRow" and len(cells) >= 2:
                bank_total = _parse_signed(cells[1])
        break

    # If filtered to a specific account, use its balance; otherwise use Total Bank
    if bank_accounts and PRIMARY_BANK_ACCOUNT_NAME:
        bs_bank_total = sum(a["amount"] for a in bank_accounts)
    elif bank_total is not None:
        bs_bank_total = bank_total
    else:
        bs_bank_total = sum(a["amount"] for a in bank_accounts) if bank_accounts else None

    # --- Current Liabilities section ---
    liab_accounts: list[dict] = []
    liab_xero_total: float | None = None
    for section in rows:
        if section.get("RowType") != "Section":
            continue
        title = (section.get("Title") or "").strip().lower()
        if "liabilit" not in title:
            continue
        sub_rows = section.get("Rows") or []
        target_rows = None
        for sub in sub_rows:
            sub_title = (sub.get("Title") or "").strip().lower()
            if sub.get("RowType") == "Section" and "current" in sub_title:
                target_rows = sub.get("Rows") or []
                break
        if target_rows is None and "current" in title:
            target_rows = sub_rows
        if target_rows is None:
            continue
        for row in target_rows:
            rt = row.get("RowType")
            cells = row.get("Cells") or []
            if rt == "Row" and len(cells) >= 2:
                name = (cells[0].get("Value") or "").strip()
                amount = _parse_abs(cells[1])
                if name and amount > 0.01 and not _is_bookkeeping_artefact(name):
                    liab_accounts.append({"name": name, "amount": amount})
            elif rt == "SummaryRow" and len(cells) >= 2:
                liab_xero_total = _parse_abs(cells[1])
        break

    if not liab_accounts and bs_bank_total is None:
        return None

    liab_clean_total = sum(a["amount"] for a in liab_accounts)
    return {
        "liabilities": {
            "total": liab_clean_total,
            "accounts": liab_accounts,
            "xero_total": liab_xero_total,
        },
        "bank": {
            "total": bs_bank_total,
            "accounts": bank_accounts,
        },
    }


def _fetch_balance_sheet_liabilities(as_of_date: datetime) -> dict | None:
    """Convenience wrapper — returns the liabilities portion of the Balance Sheet."""
    bs = _fetch_balance_sheet(as_of_date)
    if not bs:
        return None
    liab = bs.get("liabilities") or {}
    return liab if liab.get("accounts") else None


def _fetch_outstanding_bills() -> list[dict]:
    """Fetch unpaid supplier bills (accounts payable) from Xero with real invoice due dates.

    Returns a list of dicts: {name, amount, due_date, due_month, overdue}
    Only includes bills with AmountDue > 0 and status AUTHORISED or SUBMITTED.
    """
    try:
        resp = _xero_get("Invoices", params={
            "Type": "ACCPAY",
            "Statuses": "AUTHORISED,SUBMITTED",
            "where": "AmountDue>0",
            "summaryOnly": "false",
        })
        if resp.status_code != 200:
            return []
        invoices = resp.json().get("Invoices") or []
        today = datetime.now().date()
        bills = []
        for inv in invoices:
            amount_due = float(inv.get("AmountDue") or 0)
            if amount_due < 0.01:
                continue
            contact = (inv.get("Contact") or {}).get("Name") or "Unknown supplier"
            due_raw = inv.get("DueDateString") or inv.get("DueDate") or ""
            # Xero returns dates as "/Date(1234567890000+0000)/" or ISO strings
            due_date = None
            if due_raw.startswith("/Date("):
                try:
                    # Extract digits only — strip timezone offset and trailing )/
                    import re as _re
                    m = _re.search(r"/Date\((-?\d+)", due_raw)
                    if m:
                        due_date = datetime.utcfromtimestamp(int(m.group(1)) / 1000).date()
                except Exception:
                    pass
            elif due_raw:
                try:
                    due_date = datetime.fromisoformat(due_raw[:10]).date()
                except ValueError:
                    pass
            if due_date:
                due_month = f"{due_date.year}-{due_date.month:02d}"
                overdue = due_date < today
            else:
                due_month = f"{today.year}-{today.month:02d}"
                overdue = False
            bills.append({
                "name": contact,
                "amount": round(amount_due, 2),
                "due_month": due_month,
                "due_date": due_date.isoformat() if due_date else None,
                "overdue": overdue,
                "type": "payable",
            })
        # Sort by due date ascending
        bills.sort(key=lambda b: b["due_date"] or "9999-12-31")
        return bills
    except Exception:
        return []


def _estimate_upcoming_accruals(
    actuals_df: "pd.DataFrame",
    today: datetime,
    fy_start_month: int,
    freq_map: dict,
) -> list[dict]:
    """Estimate GST, PAYG and Super obligations not yet on the Balance Sheet.

    Uses the current month's actuals to project what will be owed at the next
    lodgement date.  Flagged as indicative — not confirmed Balance Sheet values.
    """
    accruals = []
    if actuals_df is None or actuals_df.empty:
        return accruals

    cur_month_start = datetime(today.year, today.month, 1)
    cur_month_end = (pd.Timestamp(cur_month_start) + pd.DateOffset(months=1) - pd.Timedelta(days=1)).to_pydatetime()

    cur_mask = (
        (actuals_df["JOURNAL_DATE"] >= cur_month_start) &
        (actuals_df["JOURNAL_DATE"] <= cur_month_end)
    )
    cur_df = actuals_df[cur_mask]

    # GST estimate: 10% of net revenue this month
    rev_mask = cur_df["ACCOUNT_TYPE"].isin(["REVENUE", "SALES", "OTHERINCOME"]) if "ACCOUNT_TYPE" in cur_df.columns else pd.Series(False, index=cur_df.index)
    revenue_this_month = abs(float(pd.to_numeric(cur_df.loc[rev_mask, "NET_AMOUNT"], errors="coerce").fillna(0).sum()))
    if revenue_this_month > 1.0:
        gst_estimate = round(revenue_this_month * 0.10, 2)
        qe = _ato_quarter_end(today)
        due = _ato_bas_due(qe)
        due = _next_business_day_if_weekend(due)
        accruals.append({
            "name": "GST (estimated)",
            "amount": gst_estimate,
            "month": f"{due.year}-{due.month:02d}",
            "due_date": due.strftime("%Y-%m-%d"),
            "type": "gst_accrual",
            "indicative": True,
        })

    # PAYG estimate: ~28% of wages this month (average withholding rate)
    wages_mask = cur_df["ACCOUNT_TYPE"].isin(["DIRECTCOSTS", "EXPENSE", "OVERHEADS"]) if "ACCOUNT_TYPE" in cur_df.columns else pd.Series(False, index=cur_df.index)
    wages_name_mask = cur_df["ACCOUNT_NAME"].str.lower().str.contains("wage|salary|payroll", na=False) if "ACCOUNT_NAME" in cur_df.columns else pd.Series(False, index=cur_df.index)
    wages_this_month = abs(float(pd.to_numeric(cur_df.loc[wages_mask & wages_name_mask, "NET_AMOUNT"], errors="coerce").fillna(0).sum()))
    if wages_this_month > 1.0:
        super_estimate = round(wages_this_month * 0.11, 2)
        qe = _ato_quarter_end(today)
        due = _ato_super_due(qe)
        due = _next_business_day_if_weekend(due)
        accruals.append({
            "name": "Super (estimated)",
            "amount": super_estimate,
            "month": f"{due.year}-{due.month:02d}",
            "due_date": due.strftime("%Y-%m-%d"),
            "type": "super_accrual",
            "indicative": True,
        })

    return accruals


def _build_sales_series(
    actual_df: pd.DataFrame,
    budget_df: pd.DataFrame,
    fy_start: datetime,
    fy_end: datetime,
    today: datetime,
    actual_revenue_override: list | None = None,
) -> dict:
    months = _month_range(fy_start, fy_end)
    current_month = datetime(today.year, today.month, 1)

    actual_rev = actual_revenue_override if actual_revenue_override is not None else _monthly_series(actual_df, months, "REVENUE")
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
    budget_projection = budget_fy.copy()

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
            _monthly_series(budget_projection, months, "REVENUE"),
            _monthly_series(budget_projection, months, "EXPENSE"),
        )
    ]
    has_budget_projection = not budget_projection.empty
    projected_profit = [
        a if m <= current_month else (b if has_budget_projection else None)
        for m, a, b in zip(months, actual_profit, budget_profit)
    ]
    future_profit = float(np.sum([v for v in projected_profit if v is not None])) if has_budget_projection else None

    # Expenses come from actual journal lines (actuals_fy) and budget for future months.
    actual_expense = _monthly_series(actuals_fy, months, "EXPENSE")
    budget_expense = _monthly_series(budget_projection, months, "EXPENSE")
    projected_expense = [
        a if m <= current_month else (b if has_budget_projection else None)
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

    sales_series = _build_sales_series(actuals_fy, budget_projection, fy_start, fy_end, today)
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
    budget_projection = budget_fy.copy()

    current_month = anchor_month
    next_month = (pd.Timestamp(current_month) + pd.DateOffset(months=1)).to_pydatetime()
    previous_month = (pd.Timestamp(current_month) - pd.DateOffset(months=1)).to_pydatetime()

    actuals_to_date = actuals_fy[actuals_fy["JOURNAL_DATE"] < next_month]

    months = _month_range(fy_start, fy_end)
    prev_fy_start = (pd.Timestamp(fy_start) - pd.DateOffset(years=1)).to_pydatetime()
    prev_fy_end = (pd.Timestamp(fy_end) - pd.DateOffset(years=1)).to_pydatetime()
    prev_next_month = (pd.Timestamp(next_month) - pd.DateOffset(years=1)).to_pydatetime()
    prev_months = _month_range(prev_fy_start, prev_fy_end)

    # Fetch P&L from Xero Reports API — accurate actuals, GST excluded, matches Xero UI.
    # Falls back to journal-line aggregation if the API call fails.
    _pl      = _fetch_pl_report(fy_start, fy_end)
    _pl_prev = _fetch_pl_report(prev_fy_start, prev_fy_end)

    _pl_revenue      = _pl["revenue"]      if _pl      else _monthly_series(actuals_fy, months, "REVENUE")
    _pl_expense      = _pl["expense"]      if _pl      else _monthly_series(actuals_fy, months, "EXPENSE")
    _pl_prev_revenue = _pl_prev["revenue"] if _pl_prev else _monthly_series(
        actuals[(actuals["JOURNAL_DATE"] >= prev_fy_start) & (actuals["JOURNAL_DATE"] < prev_next_month)],
        prev_months, "REVENUE",
    )
    _pl_prev_expense = _pl_prev["expense"] if _pl_prev else _monthly_series(
        actuals[(actuals["JOURNAL_DATE"] >= prev_fy_start) & (actuals["JOURNAL_DATE"] < prev_next_month)],
        prev_months, "EXPENSE",
    )

    # YTD profit: sum P&L actuals up to and including current_month
    cur_idx = next((i for i, m in enumerate(months) if m >= current_month), len(months) - 1)
    revenue_value = sum(_pl_revenue[: cur_idx + 1])
    expense_value = sum(_pl_expense[: cur_idx + 1])
    profit_now = revenue_value - expense_value

    actual_profit = [r - e for r, e in zip(_pl_revenue, _pl_expense)]
    # P&L only returns actuals so future months are already 0 — same as actuals_to_date
    actual_profit_to_date = [r - e for r, e in zip(_pl_revenue, _pl_expense)]

    previous_year_profit_to_date = [r - e for r, e in zip(_pl_prev_revenue, _pl_prev_expense)]
    actual_profit_ytd = float(np.sum(actual_profit_to_date)) if actual_profit_to_date else 0.0
    previous_year_profit_ytd = (
        float(np.sum(previous_year_profit_to_date))
        if previous_year_profit_to_date
        else None
    )
    budget_profit = [
        r - e
        for r, e in zip(
            _monthly_series(budget_projection, months, "REVENUE"),
            _monthly_series(budget_projection, months, "EXPENSE"),
        )
    ]
    has_budget_projection = not budget_projection.empty
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
        prev_idx = next((i for i, m in enumerate(months) if m >= previous_month_cutoff), len(months) - 1)
        profit_now_prev = float(sum(_pl_revenue[: prev_idx + 1]) - sum(_pl_expense[: prev_idx + 1]))
    else:
        profit_now_prev = None

    actual_expense = _pl_expense
    actual_revenue = _pl_revenue
    budget_expense = _monthly_series(budget_projection, months, "EXPENSE")
    projected_expense = [
        a if m <= current_month else (b if has_budget_projection else None)
        for m, a, b in zip(months, actual_expense, budget_expense)
    ]

    sales_series = _build_sales_series(actuals_fy, budget_projection, fy_start, fy_end, today, actual_revenue_override=_pl_revenue)
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
    bank_rows = _filter_bank_rows_for_selected_account(bank_rows)
    bank_rows_all = actuals[
        (actuals["ACCOUNT_TYPE"] == "BANK")
        & (actuals["JOURNAL_DATE"] < next_month)
    ].copy()
    bank_rows_all = _filter_bank_rows_for_selected_account(bank_rows_all)
    bank_rows_before_current = actuals[
        (actuals["ACCOUNT_TYPE"] == "BANK")
        & (actuals["JOURNAL_DATE"] < current_month)
    ].copy()
    bank_rows_before_current = _filter_bank_rows_for_selected_account(bank_rows_before_current)
    bank_burn_series: list[float] = []
    bank_monthly_net: list[float | None] = []
    cashflow_cash_in: list[float] = []
    cashflow_cash_out: list[float] = []
    previous_month_balance = None
    bank_balance_proxy = None
    bank_in = pd.Series(dtype=float)
    bank_out = pd.Series(dtype=float)
    if len(bank_rows):
        bank_rows["MONTH"] = bank_rows["JOURNAL_DATE"].dt.to_period("M").dt.to_timestamp()
        # Actual cash in/out from bank account journal lines.
        # Positive NET_AMOUNT = cash received into bank, negative = cash paid out.
        bank_in  = bank_rows.loc[bank_rows["NET_AMOUNT"] > 0].groupby("MONTH")["NET_AMOUNT"].sum()
        bank_out = bank_rows.loc[bank_rows["NET_AMOUNT"] < 0].groupby("MONTH")["NET_AMOUNT"].sum().abs()
        for idx, m in enumerate(months):
            if m > current_month:
                bank_monthly_net.append(None)
                cashflow_cash_in.append(0.0)
                cashflow_cash_out.append(0.0)
                continue
            inflow  = float(bank_in.get(pd.Timestamp(m), 0.0))
            outflow = float(bank_out.get(pd.Timestamp(m), 0.0))
            bank_monthly_net.append(inflow - outflow)
            bank_burn_series.append(max(0.0, outflow - inflow))
            cashflow_cash_in.append(inflow)
            cashflow_cash_out.append(outflow)
    else:
        cashflow_cash_in  = [0.0] * len(months)
        cashflow_cash_out = [0.0] * len(months)
        bank_monthly_net  = [None] * len(months)
    if len(bank_rows_all):
        bank_balance_proxy = float(bank_rows_all["NET_AMOUNT"].sum())
    if len(bank_rows_before_current):
        previous_month_balance = float(bank_rows_before_current["NET_AMOUNT"].sum())
    if bank_burn_series:
        tail = bank_burn_series[-burn_months:] if burn_months > 0 else bank_burn_series
        monthly_burn = float(np.mean(tail))
    else:
        monthly_burn = None

    live_cash_balance, live_cash_balance_error = _load_live_bank_balance_xero()

    # Fetch Balance Sheet once — provides both bank balance (fallback) and liabilities.
    _bs_full = _fetch_balance_sheet(today)
    _bs = (_bs_full or {}).get("liabilities") if _bs_full and (_bs_full.get("liabilities") or {}).get("accounts") else None

    # Use Balance Sheet bank total when the Accounts API returns no balance
    if live_cash_balance is None and _bs_full:
        bs_bank_total = (_bs_full.get("bank") or {}).get("total")
        if bs_bank_total is not None:
            live_cash_balance = bs_bank_total
            live_cash_balance_error = None

    effective_cash_balance = (
        float(live_cash_balance)
        if live_cash_balance is not None
        else (
            float(cash_balance)
            if cash_balance is not None
            else bank_balance_proxy
        )
    )
    if effective_cash_balance is not None and len(bank_rows):
        current_month_inflow = float(bank_in.get(pd.Timestamp(current_month), 0.0))
        current_month_outflow = float(bank_out.get(pd.Timestamp(current_month), 0.0))
        current_month_net = current_month_inflow - current_month_outflow
        if live_cash_balance is not None:
            previous_month_balance = float(effective_cash_balance) - current_month_net

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
    if live_cash_balance is None and live_cash_balance_error:
        warnings.append(f"Live Xero cash balance unavailable: {live_cash_balance_error}")

    if budget.empty:
        warnings.append("No manual budget yet. Future Profit is unavailable until budget rows are added.")

    # Current Liabilities — use Balance Sheet parsed earlier (same API call, no extra request).
    current_liabilities = _bs["total"] if _bs else None

    # Fall back to journal lines if Balance Sheet fetch failed.
    _liab_all = actuals[actuals["JOURNAL_DATE"] <= pd.Timestamp(today)]
    if current_liabilities is None:
        if "ACCOUNT_TYPE" in _liab_all.columns and "NET_AMOUNT" in _liab_all.columns:
            cur_df = _liab_all.loc[_liab_all["ACCOUNT_TYPE"] == "CURRLIAB"].copy()
            if len(cur_df):
                code_col = cur_df["ACCOUNT_CODE"].fillna("").astype(str).str.strip() if "ACCOUNT_CODE" in cur_df.columns else pd.Series("", index=cur_df.index)
                name_col = cur_df["ACCOUNT_NAME"].fillna("").astype(str).str.strip() if "ACCOUNT_NAME" in cur_df.columns else pd.Series("", index=cur_df.index)
                cur_df["_LIAB_KEY"] = code_col.where(code_col != "", name_col)
                cur_df = cur_df[cur_df["_LIAB_KEY"] != ""]
                cur_df = cur_df[~name_col.reindex(cur_df.index).map(_is_bookkeeping_artefact)]
                if len(cur_df):
                    balances = cur_df.groupby("_LIAB_KEY")["NET_AMOUNT"].sum()
                    outstanding = balances[balances < 0].abs()
                    if len(outstanding):
                        current_liabilities = float(outstanding.sum())

    # Build per-account liability schedule for the frontend cash timeline.
    # Reuses _liab_all already filtered above — no extra API call.
    _liab_currliab = _liab_all[_liab_all["ACCOUNT_TYPE"] == "CURRLIAB"].copy() if "ACCOUNT_TYPE" in _liab_all.columns else pd.DataFrame()
    _liab_freq_map = _liability_frequency_config(lines=_liab_currliab)
    liability_schedule = _build_liability_schedule(_liab_all, today, _liab_freq_map, period="month", fy_start_month=fy_start_month)

    # Patch schedule amounts with Balance Sheet figures — BS is authoritative for outstanding balances.
    # Journal lines can diverge (payments recorded after today's cutoff, sign errors, etc.).
    # Match by account name (case-insensitive). Accounts in BS but missing from schedule
    # (e.g. Business Bank Account overdraft, which is BANK type not CURRLIAB) are added
    # to the current month so they appear in the cash timeline.
    if _bs and _bs.get("accounts"):
        _bs_by_name = {a["name"].strip().lower(): a["amount"] for a in _bs["accounts"]}
        _schedule_names = {item["name"].strip().lower() for item in liability_schedule}
        # Patch existing entries
        for item in liability_schedule:
            bs_amt = _bs_by_name.get(item["name"].strip().lower())
            if bs_amt is not None:
                item["amount"] = round(bs_amt, 2)
        # Remove entries that BS says are zero (fully paid)
        liability_schedule = [item for item in liability_schedule if item["amount"] > 0.01]
        # Add BS accounts not in schedule (no journal history / different account type)
        _current_month_str = f"{today.year}-{today.month:02d}"
        for _bs_acc in _bs["accounts"]:
            _key = _bs_acc["name"].strip().lower()
            if _key not in _schedule_names and _bs_acc["amount"] > 0.01:
                liability_schedule.append({
                    "month": _current_month_str,
                    "name": _bs_acc["name"],
                    "code": "",
                    "amount": round(_bs_acc["amount"], 2),
                    "type": "other",
                })

    # Accounts payable — real supplier invoices with actual due dates
    accounts_payable = _fetch_outstanding_bills()

    # Upcoming accruals — GST/Super estimates not yet on Balance Sheet
    upcoming_accruals = _estimate_upcoming_accruals(actuals, today, fy_start_month, _liab_freq_map)

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
            "balance_sheet_source": "xero_report" if _bs else "journal_lines_fallback",
            "balance_sheet_accounts": _bs["accounts"] if _bs else None,
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
                round(float(bank_balance_proxy), 2) if bank_balance_proxy is not None else None
            ),
            "cash_balance_prev_month": (
                round(float(previous_month_balance), 2) if previous_month_balance is not None else None
            ),
            "cash_balance_source": (
                "balance_sheet"
                if live_cash_balance is not None and _bs_full and (_bs_full.get("bank") or {}).get("total") is not None
                else ("xero" if live_cash_balance is not None else ("proxy" if bank_balance_proxy is not None else "unavailable"))
            ),
            "cash_balance_live_error": live_cash_balance_error,
            "runway_months": round(float(runway_months), 2) if runway_months is not None else None,
            "monthly_burn": round(float(monthly_burn), 2) if monthly_burn is not None else None,
            "monthly_burn_basis": "bank_net_outflow_3m",
            "sales_this_month": round(float(month_rev), 2) if month_rev is not None else None,
            "spending_this_month": round(float(month_exp), 2) if month_exp is not None else None,
            "current_liabilities": round(float(current_liabilities), 2) if current_liabilities is not None else None,
            "liability_schedule": liability_schedule,
            "accounts_payable": accounts_payable,
            "upcoming_accruals": upcoming_accruals,
            "warnings": warnings,
        },
        "charts": {
            "cashflow": cashflow,
            "cash_balance": {
                "labels": sales_series["labels"],
                "monthly_net": [round(float(v), 2) if v is not None else None for v in bank_monthly_net],
            },
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
        lines=lines,
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
                "detected_frequencies": freq_map.get("_detected", {}),
                "note": "Agent extensions not included.",
            },
            "rows": [],
        }

    period_start, period_end = _period_bounds(today, period, fy_start_month)

    # All history up to today — source of truth for outstanding balances.
    # Period filter was the old approach; it missed liabilities accrued in prior periods.
    all_lines = lines[lines["JOURNAL_DATE"] <= pd.Timestamp(today)]
    if all_lines.empty:
        # Fall back: shift today to latest available data
        latest_date = lines["JOURNAL_DATE"].max()
        if pd.notna(latest_date):
            today = latest_date.to_pydatetime() if hasattr(latest_date, "to_pydatetime") else latest_date
            period_start, period_end = _period_bounds(today, period, fy_start_month)
            all_lines = lines[lines["JOURNAL_DATE"] <= pd.Timestamp(today)]

    rows = []
    warnings = []
    for (code, name), all_grp in all_lines.groupby(["ACCOUNT_CODE", "ACCOUNT_NAME"]):
        # Skip Xero bookkeeping artefacts — opening balances, rounding, conversion entries.
        # These are not real cash liabilities and would distort committed cash totals.
        if _is_bookkeeping_artefact(name):
            continue

        all_net = pd.to_numeric(all_grp["NET_AMOUNT"], errors="coerce").fillna(0.0)
        net_position = float(all_net.sum())
        outstanding_owed = float(abs(net_position)) if net_position < 0 else 0.0
        credit_balance = float(net_position) if net_position > 0 else 0.0

        # Skip accounts fully settled (nothing owed and nothing in credit)
        if outstanding_owed == 0 and credit_balance == 0:
            continue

        # Skip negligible amounts (rounding noise under $1)
        if outstanding_owed < 1.0 and credit_balance < 1.0:
            continue

        # Period-scoped breakdown for context (what happened this month/quarter)
        period_mask = (all_grp["JOURNAL_DATE"] >= period_start) & (all_grp["JOURNAL_DATE"] <= period_end)
        period_net = pd.to_numeric(all_grp.loc[period_mask, "NET_AMOUNT"], errors="coerce").fillna(0.0)
        obligation_created = float(period_net[period_net < 0].abs().sum())
        amount_paid = float(period_net[period_net > 0].sum())

        # Warn when all-time outstanding is more than 3x the period obligation —
        # this usually means the liability has been accruing without regular ATO payments.
        if outstanding_owed > 1.0 and obligation_created > 0 and outstanding_owed > obligation_created * 3:
            warnings.append(
                f"{name} ({code}): all-time outstanding ${outstanding_owed:,.2f} is significantly "
                f"higher than this period's obligation ${obligation_created:,.2f}. "
                "Check whether historical payments have been recorded in Xero."
            )

        # Dates from all history
        first_accrual = all_grp.loc[all_net < 0, "JOURNAL_DATE"].min()
        last_activity = all_grp["JOURNAL_DATE"].max()
        last_payment = all_grp.loc[all_net > 0, "JOURNAL_DATE"].max()

        # Due date based on the period of the last accrual, not the current period.
        # Example: Feb GST last accrued in Feb → due Mar 21 → shows Overdue if unpaid in March.
        last_accrual_ts = all_grp.loc[all_net < 0, "JOURNAL_DATE"].max()
        if pd.notna(last_accrual_ts):
            last_accrual_dt = last_accrual_ts.to_pydatetime() if hasattr(last_accrual_ts, "to_pydatetime") else last_accrual_ts
            _, accrual_period_end = _period_bounds(last_accrual_dt, period, fy_start_month)
        else:
            accrual_period_end = period_end

        ltype = _liability_type(code, name)
        last_accrual_dt_debug = last_accrual_ts.to_pydatetime() if pd.notna(last_accrual_ts) and hasattr(last_accrual_ts, "to_pydatetime") else (last_accrual_ts if pd.notna(last_accrual_ts) else None)
        expected_due, basis_rule = _expected_due_date(ltype, accrual_period_end, freq_map, last_accrual_dt=last_accrual_dt_debug)
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
                "outstanding_basis": "all_history",
                "configuration_used": {
                    "GST_FREQUENCY": freq_map.get("GST"),
                    "PAYG_FREQUENCY": freq_map.get("PAYG"),
                    "SUPER_FREQUENCY": freq_map.get("SUPER"),
                },
                "detected_frequencies": freq_map.get("_detected", {}),
                "warnings": warnings,
                "note": "Outstanding balances reflect all-time journal history. obligation_created/amount_paid reflect the selected period only.",
            },
            "rows": rows,
        }
    )



@app.route("/api/debug/config")
def debug_config():
    return jsonify(
        {
            "mode": "xero-with-supabase",
            "note": "This API integrates Xero accounting data with Supabase budget storage.",
            "budget_backend": "supabase",
            "supabase_url_set": bool(SUPABASE_DB_URL),
        }
    )


@app.route("/api/debug/balance-sheet")
@login_required
def debug_balance_sheet():
    """Return the raw Xero Balance Sheet response so the parser can be verified."""
    try:
        resp = _xero_get(
            "Reports/BalanceSheet",
            params={"date": datetime.today().strftime("%Y-%m-%d"), "paymentsOnly": "false"},
        )
        resp.raise_for_status()
        raw = resp.json()
    except Exception as e:
        return jsonify({"error": str(e)}), 500

    parsed = _fetch_balance_sheet(datetime.today())
    return jsonify({"raw": raw, "parsed": parsed})

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

    # user_id must come from Supabase Auth session — no fallback to random UUID
    # since xero_tokens.user_id references auth.users(id).
    user_id = session.get("user_id")
    if not user_id:
        return redirect("/login")
    session["tenant_id"] = tenant_ids[0]

    _persist_tokens_for_tenants(user_id, tenant_ids, tokens)
    return redirect("/dashboard")


@app.route("/auth/logout")
def auth_logout():
    clear_tokens = str(request.args.get("clear_tokens", "false")).lower() in {"1", "true", "yes"}
    user_id = session.get("user_id")
    session.clear()
    if clear_tokens and user_id:
        with _supabase_conn() as conn:
            with conn.cursor() as cur:
                cur.execute("DELETE FROM xero_tokens WHERE user_id = %s", (user_id,))
                cur.execute("DELETE FROM users WHERE id = %s", (user_id,))
            conn.commit()
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
    with _supabase_conn() as conn:
        with conn.cursor() as cur:
            cur.execute(
                "SELECT 1 FROM xero_tokens WHERE user_id = %s AND tenant_id = %s",
                (user_id, tenant_id),
            )
            exists = cur.fetchone()
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
    if session.get("user_id"):
        return redirect("/dashboard")

    if request.method == "POST":
        email = str(request.form.get("email", "")).strip().lower()
        password = str(request.form.get("password", ""))

        try:
            resp = requests.post(
                f"{SUPABASE_URL}/auth/v1/token?grant_type=password",
                json={"email": email, "password": password},
                headers={"apikey": SUPABASE_ANON_KEY, "Content-Type": "application/json"},
                timeout=10,
            )
        except requests.RequestException:
            return redirect("/login?error=unavailable")

        if resp.status_code != 200:
            err_desc = (resp.json().get("error_description") or "").lower()
            if "not confirmed" in err_desc or "email" in err_desc and "confirm" in err_desc:
                return redirect("/login?error=unconfirmed")
            return redirect("/login?error=invalid")

        data = resp.json()
        user_id = data.get("user", {}).get("id")
        if not user_id:
            return redirect("/login?error=invalid")

        session["user_id"] = user_id
        return redirect("/dashboard")

    return app.send_static_file("login.html")


@app.route("/login/forgot", methods=["POST"])
def login_forgot():
    """Send a Supabase password-reset email."""
    email = str(request.form.get("email", "")).strip().lower()
    if not email:
        return redirect("/login?error=forgot_missing")
    reset_url = f"{request.url_root.rstrip('/')}/login/reset"
    try:
        requests.post(
            f"{SUPABASE_URL}/auth/v1/recover",
            json={"email": email, "redirect_to": reset_url},
            headers={"apikey": SUPABASE_ANON_KEY, "Content-Type": "application/json"},
            timeout=10,
        )
    except requests.RequestException:
        pass  # fail silently — don't leak whether email exists
    return redirect("/login?forgot=sent")


@app.route("/signup", methods=["GET", "POST"])
def signup_page():
    if session.get("user_id"):
        return redirect("/dashboard")
    if request.method == "POST":
        email = str(request.form.get("email", "")).strip().lower()
        password = str(request.form.get("password", ""))
        if not email or not password:
            return redirect("/signup?error=missing")
        try:
            resp = requests.post(
                f"{SUPABASE_URL}/auth/v1/signup",
                json={"email": email, "password": password},
                headers={"apikey": SUPABASE_ANON_KEY, "Content-Type": "application/json"},
                timeout=10,
            )
        except requests.RequestException:
            return redirect("/signup?error=unavailable")
        data = resp.json()
        if resp.status_code not in (200, 201):
            msg = data.get("msg") or data.get("message") or data.get("error_description") or ""
            print(f"[signup] Supabase error {resp.status_code}: {data}", flush=True)
            if "already" in msg.lower() or "exists" in msg.lower():
                return redirect("/signup?error=exists")
            return redirect("/signup?error=failed")
        # Supabase returns 200 with identities=[] when email already exists
        identities = data.get("identities")
        if identities is not None and len(identities) == 0:
            return redirect("/signup?error=exists")
        return redirect("/login?signup=confirm")
    return app.send_static_file("signup.html")


@app.route("/login/reset", methods=["GET", "POST"])
def login_reset():
    """Password reset: GET serves the reset page; POST updates the password."""
    if request.method == "POST":
        access_token = str(request.form.get("access_token", "")).strip()
        new_password = str(request.form.get("password", ""))
        if not access_token or not new_password:
            return redirect("/login/reset?error=missing")
        try:
            resp = requests.put(
                f"{SUPABASE_URL}/auth/v1/user",
                json={"password": new_password},
                headers={
                    "apikey": SUPABASE_ANON_KEY,
                    "Authorization": f"Bearer {access_token}",
                    "Content-Type": "application/json",
                },
                timeout=10,
            )
        except requests.RequestException:
            return redirect(f"/login/reset?error=unavailable#access_token={access_token}&type=recovery")
        if resp.status_code != 200:
            return redirect(f"/login/reset?error=failed#access_token={access_token}&type=recovery")
        return redirect("/login?reset=done")
    return app.send_static_file("reset.html")


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
            "token_storage": "supabase",
            "has_access_token": bool(tokens.get("access_token")),
            "has_refresh_token": bool(tokens.get("refresh_token")),
            "token_valid": token_is_valid(tokens),
            "token_expires_in": int(tokens.get("expires_at", 0)) - now,
            "note": "If token expired and no refresh_token, go to /auth to re-authorize",
            "data_mode": "xero",
            "budget_backend": "supabase",
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
        if request.method == "GET":
            budget_df = _load_budget_df_active()
            rows = budget_df.copy()
            if "JOURNAL_DATE" in rows.columns:
                rows["JOURNAL_DATE"] = pd.to_datetime(rows["JOURNAL_DATE"], errors="coerce").dt.strftime("%Y-%m-%d")
            return jsonify(
                {
                    "mode": "xero",
                    "budget_backend": "supabase",
                    "rows": _clean_nan_values(rows.to_dict(orient="records")),
                }
            )

        body = request.get_json(silent=True) or {}
        rows = body.get("rows", [])
        if not isinstance(rows, list):
            return jsonify({"error": "rows must be a list"}), 400

        clean = _save_budget_rows_supabase(rows)
        out = clean.copy()
        if "JOURNAL_DATE" in out.columns:
            out["JOURNAL_DATE"] = pd.to_datetime(out["JOURNAL_DATE"], errors="coerce").dt.strftime("%Y-%m-%d")
        return jsonify(
            {
                "ok": True,
                "saved_rows": int(len(out)),
                "budget_backend": "supabase",
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

