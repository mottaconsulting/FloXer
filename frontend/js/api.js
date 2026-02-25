const DEFAULT_API_BASE = "";

const API_BASE = (() => {
  if (window.API_BASE) return window.API_BASE;
  return DEFAULT_API_BASE;
})();

async function request_json(path, options = {}) {
  const tryFetch = async (base) => {
    const url = `${base}${path}`;
    const res = await fetch(url, {
      headers: { Accept: "application/json", ...(options.headers || {}) },
      cache: "no-store",
      ...options
    });

    const contentType = res.headers.get("content-type") || "";
    const clone = res.clone();
    let data = null;
    let text = "";
    try {
      data = await res.json();
    } catch {
      try { text = await clone.text(); } catch { text = ""; }
      data = null;
    }

    if (!res.ok) {
      throw new Error(data?.error || data?.details || `Request failed ${res.status}`);
    }
    return { data, res, text, contentType, url };
  };

  const primary = await tryFetch(API_BASE);
  if (
    API_BASE === "" &&
    DEFAULT_API_BASE !== "" &&
    (primary.data === null || (typeof primary.data === "object" && Object.keys(primary.data).length === 0))
  ) {
    try {
      const fallback = await tryFetch(DEFAULT_API_BASE);
      if (fallback.data !== null) return fallback.data;
    } catch {
      // keep primary result
    }
  }

  if (primary.data === null) {
    const snippet = (primary.text || "").replace(/\s+/g, " ").slice(0, 180);
    const ct = primary.contentType ? ` (${primary.contentType})` : "";
    throw new Error(`Invalid JSON response from API${ct}. ${primary.url} [${primary.res.status}] -> ${snippet || "no body"}`);
  }
  return primary.data;
}

async function fetch_json(path) {
  return request_json(path);
}

function open_auth_popup() {
  window.location.href = "/auth/start";
  return null;
}

window.XeroAPI = { fetch_json, request_json, open_auth_popup };
