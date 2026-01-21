from flask import Flask, jsonify, send_from_directory, request, redirect
from flask_cors import CORS
import requests, json, os, time, urllib.parse
from dotenv import load_dotenv

# Load environment variables from .env file
load_dotenv()

app = Flask(__name__)
CORS(app)  # Enable CORS for all domains

# Configuration
CLIENT_ID = os.getenv("XERO_CLIENT_ID")
CLIENT_SECRET = os.getenv("XERO_CLIENT_SECRET")
TENANT_ID = os.getenv("XERO_TENANT_ID")   # Get this once through /connections
TOKENS_FILE = "tokens.json"
REDIRECT_URI = "http://localhost:5000/callback"  # URL for callback after authorization

# OAuth endpoints
@app.route("/auth")
def auth():
    """Initiates OAuth process - redirects to Xero for authorization"""
    auth_url = (
        "https://login.xero.com/identity/connect/authorize?"
        "response_type=code&"
        f"client_id={CLIENT_ID}&"
        f"redirect_uri={urllib.parse.quote(REDIRECT_URI)}&"
        "scope=accounting.transactions accounting.contacts accounting.settings accounting.journals.read offline_access&"
        "prompt=login"  # Force authorization screen to appear
    )
    return redirect(auth_url)

@app.route("/callback")
def callback():
    """Handles callback from Xero after authorization"""
    code = request.args.get("code")
    if not code:
        return jsonify({"error": "No authorization code received"}), 400
    
    print(f"Received authorization code: {code[:20]}...")
    
    # Exchange code for tokens
    token_response = requests.post(
        "https://identity.xero.com/connect/token",
        data={
            "grant_type": "authorization_code",
            "code": code,
            "redirect_uri": REDIRECT_URI,
        },
        auth=(CLIENT_ID, CLIENT_SECRET),
    )
    
    print(f"Token response status: {token_response.status_code}")
    print(f"Token response: {token_response.text}")
    
    if token_response.status_code != 200:
        return jsonify({"error": "Failed to get tokens", "details": token_response.text}), 400
    
    tokens = token_response.json()
    print(f"Received tokens: {list(tokens.keys())}")
    
    # Save tokens
    tokens["expires_at"] = int(time.time()) + tokens["expires_in"] - 30
    save_tokens(tokens)
    print("Tokens saved to file")
    
    # Get information about connected organizations
    connections_response = requests.get(
        "https://api.xero.com/connections",
        headers={"Authorization": f"Bearer {tokens['access_token']}"}
    )
    
    connections = connections_response.json() if connections_response.status_code == 200 else []
    
    # Return HTML page that automatically closes the window
    success_html = f"""
    <!DOCTYPE html>
    <html>
    <head>
        <title>Authorization Successful</title>
        <style>
            body {{ font-family: Arial, sans-serif; text-align: center; padding: 50px; }}
            .success {{ color: #28a745; font-size: 24px; margin-bottom: 20px; }}
            .details {{ background: #f8f9fa; padding: 20px; border-radius: 8px; margin: 20px 0; }}
            .auto-close {{ color: #666; font-size: 14px; }}
        </style>
    </head>
    <body>
        <div class="success">✓ Authorization Successful!</div>
        <div class="details">
            <p><strong>Tokens saved:</strong> Yes</p>
            <p><strong>Has refresh token:</strong> {"Yes" if "refresh_token" in tokens else "No"}</p>
            <p><strong>Connected organization:</strong> {connections[0].get("tenantName", "Unknown") if connections else "None"}</p>
        </div>
        <div class="auto-close">This window will close automatically in 3 seconds...</div>
        
        <script>
            // Automatically close window after 3 seconds
            setTimeout(() => {{
                window.close();
            }}, 3000);
            
            // Also allow closing window by clicking
            document.addEventListener('click', () => {{
                window.close();
            }});
        </script>
    </body>
    </html>
    """
    
    return success_html

@app.route("/connections")
def get_connections():
    """Gets list of connected organizations"""
    tokens = load_tokens()
    if not tokens.get("access_token"):
        return jsonify({"error": "No access token. Please authorize first at /auth"}), 401
    
    response = requests.get(
        "https://api.xero.com/connections",
        headers={"Authorization": f"Bearer {tokens['access_token']}"}
    )
    
    if response.status_code == 200:
        connections = response.json()
        return jsonify({
            "connections": connections,
            "tenant_ids": [conn.get("tenantId") for conn in connections],
            "instructions": "Copy one of the tenant_ids above and add XERO_TENANT_ID=<tenant_id> to your .env file"
        })
    else:
        return jsonify({"error": "Failed to get connections", "details": response.text}), response.status_code

# Add diagnostic endpoint
@app.route("/")
def index():
    return send_from_directory(".", "index.html")

@app.route("/setup")
def setup():
    return send_from_directory(".", "setup.html")

@app.route("/health")
def health():
    tokens = load_tokens()
    now = int(time.time())
    token_valid = "expires_at" in tokens and now < tokens["expires_at"]
    
    return jsonify({
        "status": "ok",
        "has_client_id": bool(CLIENT_ID),
        "has_client_secret": bool(CLIENT_SECRET), 
        "has_tenant_id": bool(TENANT_ID),
        "tokens_file_exists": os.path.exists(TOKENS_FILE),
        "has_access_token": bool(tokens.get("access_token")),
        "has_refresh_token": bool(tokens.get("refresh_token")),
        "token_valid": token_valid,
        "token_expires_in": tokens.get("expires_at", 0) - now if tokens.get("expires_at") else 0,
        "note": "If token expired and no refresh_token, go to /auth to re-authorize"
    })

def load_tokens():
    if os.path.exists(TOKENS_FILE):
        with open(TOKENS_FILE, "r") as f:
            return json.load(f)
    return {}

def save_tokens(tokens):
    with open(TOKENS_FILE, "w") as f:
        json.dump(tokens, f)

def get_access_token():
    tokens = load_tokens()
    now = int(time.time())

    # if token is still valid → return it
    if "expires_at" in tokens and now < tokens["expires_at"]:
        print(f"Using existing access token, expires in {tokens['expires_at'] - now} seconds")
        return tokens["access_token"]

    # check for refresh_token
    if not tokens.get("refresh_token"):
        print("No refresh_token found. Current token expired.")
        raise Exception("Access token expired and no refresh token available. Please re-authorize at http://localhost:5000/auth")

    # otherwise refresh the token
    try:
        resp = requests.post(
            "https://identity.xero.com/connect/token",
            data={
                "grant_type": "refresh_token",
                "refresh_token": tokens["refresh_token"],
            },
            auth=(CLIENT_ID, CLIENT_SECRET),
        )
        resp.raise_for_status()  # raises exception on HTTP errors
    except requests.exceptions.RequestException as e:
        raise Exception(f"Failed to refresh token: {e}")

    new_tokens = resp.json()
    new_tokens["expires_at"] = now + new_tokens["expires_in"] - 30  # 30 sec buffer
    save_tokens(new_tokens)

    return new_tokens["access_token"]

@app.route("/api/invoices")
def get_invoices():
    try:
        # Check for required environment variables
        print(f"CLIENT_ID: {bool(CLIENT_ID)}")
        print(f"CLIENT_SECRET: {bool(CLIENT_SECRET)}")  
        print(f"TENANT_ID: {bool(TENANT_ID)}")
        
        if not CLIENT_ID or not CLIENT_SECRET or not TENANT_ID:
            error_msg = {
                "error": "Missing required environment variables", 
                "missing": {
                    "XERO_CLIENT_ID": not bool(CLIENT_ID),
                    "XERO_CLIENT_SECRET": not bool(CLIENT_SECRET),
                    "XERO_TENANT_ID": not bool(TENANT_ID)
                }
            }
            print(f"Environment error: {error_msg}")
            return jsonify(error_msg), 500

        access_token = get_access_token()

        resp = requests.get(
            "https://api.xero.com/api.xro/2.0/Invoices",
            headers={
                "Authorization": f"Bearer {access_token}",
                "Xero-tenant-id": TENANT_ID,
                "Accept": "application/json",
            },
        )
        
        if resp.status_code != 200:
            error_details = resp.text
            if resp.status_code == 401:
                error_details += " - Token may be expired. Please re-authorize."
            return jsonify({
                "error": f"Xero API error: {resp.status_code}", 
                "details": error_details,
                "suggestion": "Click 'Authorize Xero' to get new tokens" if resp.status_code == 401 else None
            }), resp.status_code

        return jsonify(resp.json())
    
    except Exception as e:
        print(f"Exception in get_invoices: {str(e)}")
        return jsonify({"error": str(e)}), 500

@app.route("/api/contacts")
def get_contacts():
    try:
        print(f"Loading contacts - CLIENT_ID: {bool(CLIENT_ID)}")
        
        if not CLIENT_ID or not CLIENT_SECRET or not TENANT_ID:
            return jsonify({"error": "Missing required environment variables"}), 500

        access_token = get_access_token()

        resp = requests.get(
            "https://api.xero.com/api.xro/2.0/Contacts",
            headers={
                "Authorization": f"Bearer {access_token}",
                "Xero-tenant-id": TENANT_ID,
                "Accept": "application/json",
            },
        )
        
        if resp.status_code != 200:
            error_details = resp.text
            if resp.status_code == 401:
                error_details += " - Token may be expired. Please re-authorize."
            return jsonify({
                "error": f"Xero API error: {resp.status_code}", 
                "details": error_details,
                "suggestion": "Click 'Authorize Xero' to get new tokens" if resp.status_code == 401 else None
            }), resp.status_code

        return jsonify(resp.json())
    
    except Exception as e:
        print(f"Exception in get_contacts: {str(e)}")
        return jsonify({"error": str(e)}), 500

@app.route("/api/accounts")
def get_accounts():
    try:
        print(f"Loading accounts - CLIENT_ID: {bool(CLIENT_ID)}")
        
        if not CLIENT_ID or not CLIENT_SECRET or not TENANT_ID:
            return jsonify({"error": "Missing required environment variables"}), 500

        access_token = get_access_token()

        resp = requests.get(
            "https://api.xero.com/api.xro/2.0/Accounts",
            headers={
                "Authorization": f"Bearer {access_token}",
                "Xero-tenant-id": TENANT_ID,
                "Accept": "application/json",
            },
        )
        
        if resp.status_code != 200:
            error_details = resp.text
            if resp.status_code == 401:
                error_details += " - Token may be expired. Please re-authorize."
            return jsonify({
                "error": f"Xero API error: {resp.status_code}", 
                "details": error_details,
                "suggestion": "Click 'Authorize Xero' to get new tokens" if resp.status_code == 401 else None
            }), resp.status_code

        return jsonify(resp.json())
    
    except Exception as e:
        print(f"Exception in get_accounts: {str(e)}")
        return jsonify({"error": str(e)}), 500

@app.route("/api/journals")
def get_journals():
    try:
        print(f"Loading journals - CLIENT_ID: {bool(CLIENT_ID)}")
        
        if not CLIENT_ID or not CLIENT_SECRET or not TENANT_ID:
            return jsonify({"error": "Missing required environment variables"}), 500

        access_token = get_access_token()

        # According to documentation, we can add offset and paymentsOnly parameters
        resp = requests.get(
            "https://api.xero.com/api.xro/2.0/Journals",
            headers={
                "Authorization": f"Bearer {access_token}",
                "Xero-tenant-id": TENANT_ID,
                "Accept": "application/json",
            },
            params={
                "offset": 0,  # Start from first record
                "paymentsOnly": "false"  # Include all journals, not just payments
            }
        )
        
        print(f"Journals API response status: {resp.status_code}")
        if resp.status_code != 200:
            print(f"Journals API response: {resp.text[:500]}...")
        
        if resp.status_code != 200:
            error_details = resp.text
            if resp.status_code == 401:
                error_details += " - Token may be expired or missing accounting.journals.read scope. Please re-authorize."
            elif resp.status_code == 403:
                error_details += " - Insufficient permissions for journals. Check your Xero app settings."
            return jsonify({
                "error": f"Xero API error: {resp.status_code}", 
                "details": error_details,
                "suggestion": "Re-authorize to get journals permissions" if resp.status_code in [401, 403] else None
            }), resp.status_code

        return jsonify(resp.json())
    
    except Exception as e:
        print(f"Exception in get_journals: {str(e)}")
        return jsonify({"error": str(e)}), 500

if __name__ == "__main__":
    app.run(debug=True)