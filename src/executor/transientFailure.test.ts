import { describe, expect, test } from "bun:test";
import { isTransientBrokerFailure } from "./transientFailure";

describe("isTransientBrokerFailure", () => {
  test("venue and network failures are transient", () => {
    for (const reason of [
      // 2026-10-06, verbatim from prod
      "Binance /fapi/v2/account: Timeout waiting for response from backend server. Send status unknown; execution status unknown.",
      "alpaca getAccount timeout 15000ms",
      "fetch timeout 10000ms",
      "getaddrinfo ETIMEOUT api.telegram.org",
      "getaddrinfo ENOTFOUND demo-fapi.binance.com",
      "socket hang up",
      "The socket connection was closed unexpectedly. For more information, pass `verbose: true`",
      "Unable to connect. Is the computer able to access the url?",
      "connect ECONNREFUSED 13.0.0.1:443",
      "read ECONNRESET",
      "Binance /fapi/v1/positionSide/dual: HTTP 503",
      "Request failed with status code 502",
      "Too Many Requests",
      "code -1003: Too many requests; current limit is 2400 request weight per 1 MINUTE",
      "code -1001: Internal error; unable to process your request. Please try again.",
    ]) {
      expect(isTransientBrokerFailure(reason), reason).toBe(true);
    }
  });

  test("configuration problems are not (the preflight's own reasons stay fail-closed)", () => {
    for (const reason of [
      `restBase "https://fapi.binance.com" is not a paper/testnet host — refusing to enable`,
      "API keys not configured",
      "dualSidePosition must be false (one-way mode), got true",
      "multiAssetsMargin must be false (single-asset mode), got true",
      "no USDC asset row in assets[] — expected balance row missing",
      "exchangeInfo missing TRADING filters for: LTCUSDC",
      "CoinM /dapi/v1/positionSide/dual HTTP 401: API-key format invalid.",
      "Binance /fapi/v2/account: HTTP 400: Signature for this request is not valid.",
    ]) {
      expect(isTransientBrokerFailure(reason), reason).toBe(false);
    }
    expect(isTransientBrokerFailure(undefined)).toBe(false);
    expect(isTransientBrokerFailure("")).toBe(false);
  });
});
