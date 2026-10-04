// ── ws.js — live updates over the dashboard WebSocket. The 30s poll in main.js
// stays as the fallback; WS just makes fills/prices appear in <1s. Auth rides on
// the sid cookie (same-origin) — the server validates Origin + session on
// upgrade. Reconnects with exponential backoff, capped at 30s.

let ws = null, retryTimer = null, backoff = 1000;

export function connectWS(handlers) {
  clearTimeout(retryTimer);
  const proto = location.protocol === "https:" ? "wss:" : "ws:";
  try { ws = new WebSocket(`${proto}//${location.host}`); }
  catch { return schedule(handlers); }
  ws.onopen = () => { backoff = 1000; handlers.status?.(true); };
  ws.onmessage = (e) => {
    let m; try { m = JSON.parse(e.data); } catch { return; }
    if (m && m.type && handlers[m.type]) { try { handlers[m.type](m.data); } catch (err) { console.error("ws handler", err); } }
  };
  ws.onclose = () => { handlers.status?.(false); schedule(handlers); };
  ws.onerror = () => { try { ws.close(); } catch {} };
}

function schedule(handlers) {
  clearTimeout(retryTimer);
  backoff = Math.min(backoff * 2, 30000);
  retryTimer = setTimeout(() => connectWS(handlers), backoff);
}
