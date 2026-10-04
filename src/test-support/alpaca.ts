// Test-support: AlpacaExecutor fixtures. TEST-ONLY.
// The executor talks to a network; tests override instance seams
// (client/getSnapshot/…) or queue fake fetch Responses — never live calls.
import { AlpacaExecutor } from "../executor/alpaca-executor";

/** Connected executor with instance-level overrides applied (e.g.
 *  `{ resolveRetryDelayMs: 1 }`, or a fake `client`). Each test still
 *  expresses only the seams it cares about. */
export function fakeAlpacaExecutor(overrides: Record<string, any> = {}): AlpacaExecutor {
  const exec = new AlpacaExecutor() as any;
  exec.connected = true;
  Object.assign(exec, overrides);
  return exec as AlpacaExecutor;
}

/** One OHLCV bar in Alpaca's wire shape. */
export function bar(close: number, timestamp = "2026-07-15T14:00:00Z") {
  return { o: close - 1, h: close + 1, l: close - 2, c: close, v: 100, t: timestamp };
}

/** A bars-endpoint Response page (optionally with a continuation token). */
export function page(symbol: string, bars: ReturnType<typeof bar>[], next?: string) {
  return {
    ok: true,
    status: 200,
    statusText: "OK",
    json: async () => ({ bars: { [symbol]: bars }, next_page_token: next }),
  } as Response;
}

/** A quotes-endpoint Response. */
export function quote(symbol: string, ask: number, bid: number, timestamp: string) {
  return {
    ok: true,
    status: 200,
    statusText: "OK",
    json: async () => ({ quotes: { [symbol]: { ap: ask, bp: bid, t: timestamp } } }),
  } as Response;
}

export const rateLimited = {
  ok: false,
  status: 429,
  statusText: "Too Many Requests",
} as Response;

/** Replace globalThis.fetch with a strict FIFO of canned Responses; any
 *  extra call throws. Callers MUST restore globalThis.fetch afterwards
 *  (the suites do it in afterEach). */
export function fetchQueue(...responses: Response[]): void {
  globalThis.fetch = (async () => {
    const response = responses.shift();
    if (!response) throw new Error("unexpected fetch");
    return response;
  }) as unknown as typeof fetch;
}
