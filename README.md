# Xero API Integration for Budget Tool

Web application for integrating with Xero accounting API.

## Features

- **OAuth 2.0 Authentication** with Xero
- **Real-time API Integration** - Live data from Xero demo company
- **Data Visualization** - Interactive charts for invoices, contacts, accounts, and journals

## Tech Stack

- **Backend**: Python Flask
- **Frontend**: HTML/CSS/JavaScript with Chart.js
- **API**: Xero Accounting API v2.0

## Quick Start

### 1. Clone Repository
```bash
git clone <your-repo-url>
cd xero-budget-tool
```

### 2. Install Dependencies
```bash
pip install flask requests gunicorn flask-cors python-dotenv
```

### 3. Configure Environment
Create `.env` file in root directory:
```bash
XERO_CLIENT_ID=your_client_id_here
XERO_CLIENT_SECRET=your_client_secret_here
XERO_TENANT_ID=your_tenant_id_here
```

### 4. Create Token Storage
Create `tokens.json` file in root directory:
```json
{
  "access_token": "",
  "refresh_token": "",  
  "expires_at": 0
}
```

### 5. Run Application
```bash
# Development mode
python python_backend.py

# Production mode  
gunicorn -w 4 -b 0.0.0.0:5000 python_backend:app
```

### 6. Setup Xero Integration
1. Open `http://localhost:5000/setup`
2. Click "Authorize with Xero"
3. Complete OAuth flow with Xero demo company
4. Copy tenant ID to `.env` file
5. Restart server

## Usage

Open `http://localhost:5000/`

## Xero Developer Setup

1. Create app at [developer.xero.com](https://developer.xero.com)
2. Set redirect URI: `http://localhost:5000/callback`
3. Get Client ID and Client Secret
4. Use demo company for testing

## File Structure
```
├── python_backend.py      # Flask API server
├── index.html            # Main dashboard  
├── setup.html           # OAuth setup page
├── .env                 # Environment variables (not in git)
├── tokens.json          # OAuth tokens (not in git)
└── README.md           # This file
```

## Security Notes

- Never commit `.env` or `tokens.json` to version control
- Use environment variables in production
- Tokens expire every 30 minutes (auto-refresh implemented)
- Demo company recommended for testing
