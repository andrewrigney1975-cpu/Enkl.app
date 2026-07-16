"use strict";

/**
 * Tiny per-tier fetch wrapper. Node 24's built-in fetch covers everything needed — no runtime
 * dependency, matching this repo's "hand-roll rather than pull in a library" convention.
 */
export function createClient(baseUrl) {
  let token = null;

  async function request(method, path, body) {
    const headers = { 'Content-Type': 'application/json' };
    if (token) headers['Authorization'] = 'Bearer ' + token;

    const res = await fetch(baseUrl + path, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
    });

    const text = await res.text();
    let json = null;
    if (text) {
      try { json = JSON.parse(text); } catch { json = text; }
    }
    return { status: res.status, body: json };
  }

  return {
    get: (path) => request('GET', path),
    post: (path, body) => request('POST', path, body),
    put: (path, body) => request('PUT', path, body),
    del: (path) => request('DELETE', path),
    setToken: (t) => { token = t; },
  };
}

export async function waitForHealth(baseUrl, { timeoutMs = 60000, intervalMs = 1000 } = {}) {
  const deadline = Date.now() + timeoutMs;
  let lastError = null;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(baseUrl + '/health');
      if (res.ok) return true;
    } catch (err) {
      lastError = err;
    }
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
  throw new Error(`Timed out waiting for ${baseUrl}/health to come up. Last error: ${lastError}`);
}
