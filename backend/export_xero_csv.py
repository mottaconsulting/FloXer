import os
import csv
import json
import time
import requests
from dotenv import load_dotenv

load_dotenv()

BASE_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
EXPORT_DIR = os.path.join(BASE_DIR, "exports")
os.makedirs(EXPORT_DIR, exist_ok=True)

TOKENS_FILE = os.getenv("TOKENS_FILE", "tokens.json")

CLIENT_ID = os.getenv("XERO_CLIENT_ID")
CLIENT_SECRET = os.getenv("XERO_CLIENT_SECRET")
TENANT_ID_ENV = os.getenv("XERO_TENANT_ID")

XERO_TOKEN_URL = "https://identity.xero.com/connect/token"
XERO_API_BASE = "https://api.xero.com/api.xro/2.0"


# ----------------------------
# Token helpers
# ----------------------------
def load_tokens():
    if not os.path.exists(TOKENS_FILE):
        raise Exception("tokens.json not found. Run Flask app and click Authorize Xero first.")
    with open(TOKENS_FILE, "r", encoding="utf-8") as f:
        return json.load(f)


def save_tokens(tokens):
    with open(TOKENS_FILE, "w", encoding="utf-8") as f:
        json.dump(tokens, f, indent=2)


def token_is_valid(tokens):
    return int(time.time()) < int(tokens.get("expires_at", 0))


def refresh_access_token(tokens):
    if not tokens.get("refresh_token"):
        raise Exception("No refresh_token. Re-authorize at /auth in your Flask app.")

    resp = requests.post(
        XERO_TOKEN_URL,
        data={"grant_type": "refresh_token", "refresh_token": tokens["refresh_token"]},
        auth=(CLIENT_ID, CLIENT_SECRET),
        timeout=30,
    )
    resp.raise_for_status()

    new_tokens = resp.json()
    new_tokens["expires_at"] = int(time.time()) + int(new_tokens["expires_in"]) - 30
    new_tokens["tenant_id"] = tokens.get("tenant_id") or TENANT_ID_ENV

    # refresh token rotation safety
    if "refresh_token" not in new_tokens and "refresh_token" in tokens:
        new_tokens["refresh_token"] = tokens["refresh_token"]

    save_tokens(new_tokens)
    return new_tokens


def get_headers():
    tokens = load_tokens()
    if not token_is_valid(tokens):
        tokens = refresh_access_token(tokens)

    tenant_id = tokens.get("tenant_id") or TENANT_ID_ENV
    if not tenant_id:
        raise Exception("No tenant_id found. Visit /connections and /set-tenant or set XERO_TENANT_ID.")

    return {
        "Authorization": f"Bearer {tokens['access_token']}",
        "Xero-tenant-id": tenant_id,
        "Accept": "application/json",
    }


# ----------------------------
# Fetchers
# ----------------------------
def fetch_all(path, key):
    """Simple fetch (no pagination handling here). Good enough for small orgs.
    If you have lots of data, we can add pagination + date filters next.
    """
    resp = requests.get(f"{XERO_API_BASE}/{path}", headers=get_headers(), timeout=60)
    resp.raise_for_status()
    return resp.json().get(key, [])


def fetch_invoices():
    return fetch_all("Invoices", "Invoices")


def fetch_journals():
    # Journals endpoint is a bit different; still returns {"Journals": [...]}
    resp = requests.get(
        f"{XERO_API_BASE}/Journals",
        headers=get_headers(),
        params={"offset": 0, "paymentsOnly": "false"},
        timeout=60,
    )
    resp.raise_for_status()
    return resp.json().get("Journals", [])


def fetch_accounts():
    return fetch_all("Accounts", "Accounts")


def fetch_contacts():
    return fetch_all("Contacts", "Contacts")


# ----------------------------
# Small helpers
# ----------------------------
def safe_get(d, *path, default=None):
    cur = d
    for p in path:
        if not isinstance(cur, dict):
            return default
        cur = cur.get(p)
    return cur if cur is not None else default


def tracking_fields(line):
    """Return (name1, option1, name2, option2) from Xero Tracking array."""
    t = line.get("Tracking") or []
    name1 = option1 = name2 = option2 = ""
    if len(t) >= 1:
        name1 = t[0].get("Name") or ""
        option1 = t[0].get("Option") or ""
    if len(t) >= 2:
        name2 = t[1].get("Name") or ""
        option2 = t[1].get("Option") or ""
    return name1, option1, name2, option2


# ----------------------------
# CSV writers
# ----------------------------
def write_csv(filename, header, rows):
    path = os.path.join(EXPORT_DIR, filename)
    with open(path, "w", newline="", encoding="utf-8") as f:
        w = csv.writer(f)
        w.writerow(header)
        w.writerows(rows)
    print(f"✓ Wrote {filename} ({len(rows)} rows)")


def export_invoices_and_lines(invoices):
    invoice_rows = []
    line_rows = []

    for inv in invoices:
        invoice_id = inv.get("InvoiceID")
        invoice_number = inv.get("InvoiceNumber")
        contact_id = safe_get(inv, "Contact", "ContactID", default="")
        contact_name = safe_get(inv, "Contact", "Name", default="")

        invoice_rows.append([
            invoice_id,
            invoice_number,
            inv.get("Type"),
            inv.get("Status"),
            contact_id,
            contact_name,
            inv.get("Date") or inv.get("DateString"),
            inv.get("DueDate") or inv.get("DueDateString"),
            inv.get("FullyPaidOnDate") or inv.get("FullyPaidOnDateString"),
            inv.get("CurrencyCode"),
            inv.get("CurrencyRate"),
            inv.get("SubTotal"),
            inv.get("TotalTax"),
            inv.get("Total"),
            inv.get("AmountPaid"),
            inv.get("AmountDue"),
            inv.get("Reference"),
            inv.get("BrandingThemeID"),
            inv.get("SentToContact"),
            inv.get("HasAttachments"),
            inv.get("UpdatedDateUTC") or inv.get("UpdatedDateUTCString"),
        ])

        # line items (Power BI gold)
        for line in (inv.get("LineItems") or []):
            name1, opt1, name2, opt2 = tracking_fields(line)
            line_rows.append([
                invoice_id,
                invoice_number,
                inv.get("Date") or inv.get("DateString"),
                inv.get("Status"),
                contact_id,
                contact_name,
                line.get("LineItemID"),
                line.get("Description"),
                line.get("ItemCode"),
                line.get("AccountCode"),
                line.get("TaxType"),
                line.get("Quantity"),
                line.get("UnitAmount"),
                line.get("LineAmount"),
                line.get("DiscountRate"),
                line.get("TaxAmount"),
                name1, opt1, name2, opt2
            ])

    write_csv(
        "invoices.csv",
        [
            "invoice_id","invoice_number","type","status",
            "contact_id","contact_name",
            "invoice_date","due_date","fully_paid_on",
            "currency_code","currency_rate",
            "subtotal","total_tax","total",
            "amount_paid","amount_due",
            "reference","branding_theme_id","sent_to_contact","has_attachments","updated_utc"
        ],
        invoice_rows
    )

    write_csv(
        "invoice_lines.csv",
        [
            "invoice_id","invoice_number","invoice_date","status",
            "contact_id","contact_name",
            "line_item_id","description","item_code","account_code","tax_type",
            "quantity","unit_amount","line_amount","discount_rate","tax_amount",
            "tracking_name_1","tracking_option_1","tracking_name_2","tracking_option_2"
        ],
        line_rows
    )


def export_journals_and_lines(journals):
    journal_rows = []
    line_rows = []

    for j in journals:
        journal_id = j.get("JournalID")
        journal_number = j.get("JournalNumber")
        journal_date = j.get("JournalDate") or j.get("JournalDateString")

        journal_rows.append([
            journal_id,
            journal_number,
            journal_date,
            j.get("CreatedDateUTC") or j.get("CreatedDateUTCString"),
            j.get("Reference"),
            j.get("SourceType"),
        ])

        for line in (j.get("JournalLines") or []):
            name1, opt1, name2, opt2 = tracking_fields(line)
            line_rows.append([
                journal_id,
                journal_number,
                journal_date,
                line.get("JournalLineID"),
                line.get("AccountID"),
                line.get("AccountCode"),
                line.get("AccountName"),
                line.get("AccountType"),
                line.get("Description"),
                line.get("NetAmount"),
                line.get("TaxAmount"),
                line.get("GrossAmount"),
                name1, opt1, name2, opt2
            ])

    write_csv(
        "journals.csv",
        ["journal_id","journal_number","journal_date","created_utc","reference","source_type"],
        journal_rows
    )

    write_csv(
        "journal_lines.csv",
        [
            "journal_id","journal_number","journal_date",
            "journal_line_id",
            "account_id","account_code","account_name","account_type",
            "description",
            "net_amount","tax_amount","gross_amount",
            "tracking_name_1","tracking_option_1","tracking_name_2","tracking_option_2"
        ],
        line_rows
    )


def export_accounts(accounts):
    rows = []
    for a in accounts:
        rows.append([
            a.get("AccountID"),
            a.get("Code"),
            a.get("Name"),
            a.get("Type"),
            a.get("Class"),
            a.get("Status"),
            a.get("TaxType"),
            a.get("EnablePaymentsToAccount"),
            a.get("BankAccountNumber"),
            a.get("UpdatedDateUTC") or a.get("UpdatedDateUTCString")
        ])
    write_csv(
        "accounts.csv",
        [
            "account_id","code","name","type","class","status",
            "tax_type","enable_payments_to_account","bank_account_number","updated_utc"
        ],
        rows
    )


def export_contacts(contacts):
    rows = []
    for c in contacts:
        rows.append([
            c.get("ContactID"),
            c.get("Name"),
            c.get("EmailAddress"),
            c.get("ContactStatus"),
            c.get("IsCustomer"),
            c.get("IsSupplier"),
            c.get("DefaultCurrency"),
            c.get("UpdatedDateUTC") or c.get("UpdatedDateUTCString")
        ])
    write_csv(
        "contacts.csv",
        [
            "contact_id","name","email","contact_status",
            "is_customer","is_supplier","default_currency","updated_utc"
        ],
        rows
    )


# ----------------------------
# Main
# ----------------------------
if __name__ == "__main__":
    print("Exporting Xero data to CSVs for Power BI...")

    invoices = fetch_invoices()
    journals = fetch_journals()
    accounts = fetch_accounts()
    contacts = fetch_contacts()

    export_invoices_and_lines(invoices)
    export_journals_and_lines(journals)
    export_accounts(accounts)
    export_contacts(contacts)

    print(f"Done. Files are in: {EXPORT_DIR}")
