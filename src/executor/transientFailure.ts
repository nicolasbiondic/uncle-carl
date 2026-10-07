// A broker failure worth retrying — the venue or the network, not the
// installation — as opposed to a configuration problem the operator must fix
// (wrong keys, hedge mode, multi-assets margin, a production host, missing
// balance row or filters).
//
// The boot path uses it so that a transient outage on one venue with open
// positions does not take the whole bot down. 2026-10-06: Binance demo
// answered "Timeout waiting for response from backend server" (-1007) on every
// signed account read; the USDC preflight threw "refusing to boot with
// abandoned exposure" and systemd restarted the entire bot every ~10 s —
// Alpaca, the stop-loss loop and the dashboard included — while at runtime
// the same outage is tolerated (the 60 s syncs reconnect with backoff).
const TRANSIENT =
  /time(d)? ?out|ETIMEDOUT|ETIMEOUT|ECONNRESET|ECONNREFUSED|ECONNABORTED|EAI_AGAIN|ENOTFOUND|ENETUNREACH|EHOSTUNREACH|getaddrinfo|socket hang up|socket connection was closed|Unable to connect|fetch failed|backend server|server busy|-100[1378]\b|\bHTTP (429|50[0234])\b|status code (429|50[0234])\b|Too Many Requests|Service Unavailable|Bad Gateway|Gateway Time-?out|Internal Server Error/i;

export function isTransientBrokerFailure(reason: string | null | undefined): boolean {
  return typeof reason === "string" && TRANSIENT.test(reason);
}
