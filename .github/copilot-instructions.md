# MMXeroAPI - AI Coding Assistant Instructions

## Project Overview
Web application integrating Xero accounting API with a Python Flask backend and HTML/JavaScript frontend. Displays real-time financial data (invoices, contacts, accounts, journals) via interactive dashboards.

## Architecture

### Backend (`python_backend.py`)
- **Flask app** with CORS enabled for cross-origin requests
- **OAuth 2.0 flow**: `/auth` → Xero login → `/callback` (token exchange) → `tokens.json`
- **Token lifecycle**: Auto-refresh 30 seconds before expiry using refresh tokens
- **Data endpoints**: `/api/invoices`, `/api/contacts`, `/api/accounts`, `/api/journals`

### Frontend (`index.html`)
- Interactive charts using Chart.js
- Table displays for API data with filtering/sorting
- Manual and auto-refresh functionality

### Configuration
- Environment variables: `XERO_CLIENT_ID`, `XERO_CLIENT_SECRET`, `XERO_TENANT_ID`
- Tokens stored in `tokens.json` (not versioned; `.env` required for locals)
- Demo company recommended for testing

## Key Patterns

### OAuth Token Management
- **Token validation**: Check `expires_at` timestamp against `time.time()`
- **Auto-refresh**: `get_access_token()` refreshes if expired (keeps 30-sec buffer)
- **Error recovery**: 401 responses indicate token expiry; suggest re-auth via `/auth`
- **Edge case**: If refresh_token missing, user must re-authorize

### API Error Handling
All Xero endpoints follow consistent pattern:
1. Validate environment variables present
2. Get valid access token (auto-refresh)
3. Include headers: `Authorization: Bearer {token}`, `Xero-tenant-id: {TENANT_ID}`
4. Return error JSON with suggestions (e.g., "Click 'Authorize Xero'" for 401)

### Xero API Quirks
- **Journals endpoint** requires `accounting.journals.read` scope + explicit `/api/journals` route
- **Scopes needed**: `accounting.transactions`, `accounting.contacts`, `accounting.settings`, `accounting.journals.read`, `offline_access`
- **Redirect URI**: Must exactly match app registration (`http://localhost:5000/callback`)

## Developer Workflow

### Initial Setup
```bash
pip install flask requests gunicorn flask-cors python-dotenv
# Create .env and tokens.json per README
python python_backend.py  # Debug mode on localhost:5000
```

### Debugging Token Issues
- Check `/health` endpoint for token validity and config status
- Verify `.env` contains all three XERO_* variables
- Use `/connections` to get tenant ID if unknown
- Re-authorize at `/setup` if tokens stale

### Adding New Xero Endpoints
1. Create route with same pattern as existing endpoints (see `/api/journals`)
2. Call `get_access_token()` for token management
3. Include required headers: `Authorization`, `Xero-tenant-id`, `Accept: application/json`
4. Return consistent JSON with error details and user suggestions
5. Log status codes and first 500 chars of response for debugging

## Security Notes
- Never commit `.env` or `tokens.json`
- Tokens expire every 30 minutes; refresh buffer prevents stale tokens
- Demo company prevents accidental prod data modifications
- CORS enabled for local dev; secure in production
