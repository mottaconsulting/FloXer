const API_BASE = "";

async function fetch_json(path) {
  const res = await fetch(`${API_BASE}${path}`, { headers: { "Accept": "application/json" } });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data?.error || `Request failed ${res.status}`);
  return data;
}

function open_auth_popup() {
  return window.open("/auth", "_blank", "width=600,height=700");
}

window.XeroAPI = {
  fetch_json,
  open_auth_popup
};
