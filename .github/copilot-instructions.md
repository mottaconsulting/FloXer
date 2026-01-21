# MMXeroAPI - AI Coding Assistant Instructions

## Project Overview
Web application integrating Xero accounting API with a Python Flask backend and HTML/JavaScript frontend. Displays real-time financial data (invoices, contacts, accounts, journals) via interactive dashboards.

## Architecture

### Backend (`python_backend.py`)
- **Flask app** with CORS enabled for cross-origin requests
- **OAuth 2.0 flow**: `/auth` → Xero login → `/callback` (token exchange) → `tokens.json`
- **Token lifecycle**: Auto-refresh with 30-second buffer before expiry; stores `expires_at` as Unix timestamp
- **Data endpoints**: `/api/invoices`, `/api/contacts`, `/api/accounts`, `/api/journals`
- **Setup helpers**: `/setup` (HTML page), `/connections` (get tenant IDs), `/health` (diagnostics)

### Frontend (`index.html` + JavaScript)
- Interactive charts using Chart.js
- Table displays for API data with filtering/sorting/status badges
- Manual and auto-refresh buttons
- Status indicators for API health

### Configuration Files
- `.env` (not in git): `XERO_CLIENT_ID`, `XERO_CLIENT_SECRET`, `XERO_TENANT_ID`
- `tokens.json` (not in git): Stores access/refresh tokens with `expires_at` field
- `setup.html`: OAuth authorization page
- `tokens.json.example`: Template showing required structure

## Critical Implementation Details

### Token Management in `get_access_token()`
```python
# Returns valid access token, auto-refreshing if needed
if "expires_at" in tokens and now < tokens["expires_at"]:
    return tokens["access_token"]  # Still valid
# Otherwise refresh using refresh_token
# If refresh fails, raise Exception → endpoint returns 401 with user guidance
```
- **30-second buffer**: `expires_at = now + expires_in - 30` prevents race conditions
- **Edge case**: Missing refresh_token → Exception("Access token expired...Please re-authorize")

### API Error Handling Pattern
All `/api/*` endpoints follow this structure:
1. Check environment variables (log with `bool(VAR)` to avoid exposing secrets)
2. Call `get_access_token()` (handles token refresh automatically)
3. Make request with: `Authorization: Bearer {token}`, `Xero-tenant-id: {TENANT_ID}`, `Accept: application/json`
4. Check `resp.status_code` and return rich error JSON with `suggestion` field for 401/403
5. Log first 500 chars of response for debugging

### Xero API Specifics
- **Redirect URI**: Must exactly match Xero app registration (`http://localhost:5000/callback`)
- **Required scopes**: `accounting.transactions`, `accounting.contacts`, `accounting.settings`, `accounting.journals.read`, `offline_access` (in one space-separated string)
- **Journals endpoint**: Requires explicit `accounting.journals.read` scope; uses optional `offset` and `paymentsOnly` parameters
- **Connection discovery**: `/connections` endpoint helps find `tenantId` if unknown
- **Response format**: Xero returns objects with nested `Invoices`, `Contacts`, etc. arrays

## Developer Workflows

### First-Time Setup
1. Create `.env` with three XERO_* variables from Xero app dashboard
2. Create empty `tokens.json` (or copy from `tokens.json.example`)
3. Run `python python_backend.py` (Flask debug mode on localhost:5000)
4. Open `http://localhost:5000/setup` → click "Authorize with Xero"
5. Complete OAuth flow with Xero demo company
6. If tenant ID unknown, call `http://localhost:5000/connections`

### Debugging Token/Config Issues
- `/health` endpoint shows: env vars present, tokens file exists, token validity, expiry countdown
- 401 errors → tokens expired; user should click "Authorize Xero" button
- 403 errors in journals → missing `accounting.journals.read` scope; require re-auth
- No data in tables → check browser console for API errors; verify TENANT_ID matches Xero org

### Adding New Xero Endpoints
1. Add `/api/newfeature` route following pattern of `/api/invoices`
2. Use `get_access_token()` to get token (auto-refresh handled)
3. Make request to `https://api.xero.com/api.xro/2.0/Resource`
4. Return `jsonify(resp.json())` on success; return error JSON with `suggestion` field on failure
5. Test with `/health` endpoint to verify config before hitting Xero API

## Security Notes
- Never commit `.env` or `tokens.json` (both in `.gitignore`)
- Tokens valid 30 minutes; refresh buffer prevents sending expired tokens
- Demo company prevents accidental production data modification
- CORS enabled globally for local dev; restrict in production
- Log config status with booleans (not actual secrets)
