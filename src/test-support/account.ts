// Test-support: AccountManager construction. TEST-ONLY.
import { AccountManager } from "../account/AccountManager";

/** AccountManager wired to inert broker fakes; pass only the executor(s) the
 *  test exercises. Defaults: alpaca `{}` (never consulted), binance
 *  disconnected, osm `{}` — the exact filler dozens of tests repeated. */
export function makeAccountManager(deps: { alpaca?: any; binance?: any; osm?: any } = {}): AccountManager {
  return new AccountManager({
    alpaca: deps.alpaca ?? {},
    binance: deps.binance ?? { isConnected: () => false },
    osm: deps.osm ?? {},
  } as any);
}
