const API_BASE = "";

async function fetch_json(path) {
  const url = `${API_BASE}${path}`;
  const res = await fetch(url, {
    headers: { Accept: "application/json" },
    cache: "no-store"
  });

  let data = {};
  try { data = await res.json(); } catch { data = {}; }

  if (!res.ok) throw new Error(data?.error || data?.details || `Request failed ${res.status}`);
  return data;
}

function open_auth_popup() {
  return window.open("/auth", "_blank", "width=600,height=700");
}

window.XeroAPI = { fetch_json, open_auth_popup };