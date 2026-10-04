import { describe, test, expect, beforeEach } from "bun:test";
import {
  isCrossedQuote, isImpossibleFutureTs, validateCandleSeries, positionPayloadIssues,
  clockDriftMs, ClockDriftMonitor, warnThrottled, resetWarnThrottle,
  DRIFT_MIN_SAMPLES, DRIFT_ALERT_COOLDOWN_MS, NEGATIVE_LATENCY_TOLERANCE_MS, WARN_COOLDOWN_MS,
} from "./dataIntegrity";

const NOW = 1_753_800_000_000;
const HOUR = 3_600_000;

describe("isCrossedQuote (bid > ask — well-formed, physically impossible)", () => {
  test("crossed book detected", () => {
    expect(isCrossedQuote(100.5, 100.0)).toBe(true);
  });
  test("normal, locked, and unparseable books pass", () => {
    expect(isCrossedQuote(99.9, 100.0)).toBe(false);
    expect(isCrossedQuote(100.0, 100.0)).toBe(false); // locked ≠ crossed
    expect(isCrossedQuote(NaN, 100.0)).toBe(false);
    expect(isCrossedQuote(0, 0)).toBe(false);         // missing sides are a different failure
  });
});

describe("isImpossibleFutureTs (broker event stamped in OUR future)", () => {
  test("beyond tolerable drift → impossible", () => {
    expect(isImpossibleFutureTs(NOW + 60_000, NOW)).toBe(true);
  });
  test("within tolerance (normal skew) and past timestamps pass", () => {
    expect(isImpossibleFutureTs(NOW + 4_000, NOW)).toBe(false);
    expect(isImpossibleFutureTs(NOW - 1_000, NOW)).toBe(false);
  });
});

describe("validateCandleSeries (live sibling of the backtest >61min-gap throw)", () => {
  const bars = (ts: number[]) => ts.map(timestamp => ({ timestamp }));

  test("contiguous 1h series is clean", () => {
    expect(validateCandleSeries(bars([NOW, NOW + HOUR, NOW + 2 * HOUR]), HOUR)).toEqual([]);
  });
  test("missing bar (2h jump in 1h series) → gap", () => {
    const issues = validateCandleSeries(bars([NOW, NOW + HOUR, NOW + 3 * HOUR]), HOUR);
    expect(issues).toEqual([{ kind: "gap", index: 2, deltaMs: 2 * HOUR }]);
  });
  test("inverted and duplicated timestamps → out_of_order / duplicate", () => {
    const issues = validateCandleSeries(bars([NOW, NOW + HOUR, NOW, NOW]), HOUR);
    expect(issues.map(i => i.kind)).toEqual(["out_of_order", "duplicate"]);
  });
});

describe("positionPayloadIssues (real positionRisk shapes)", () => {
  test('OPEN position with markPrice "0.00000000" → impossible', () => {
    const issues = positionPayloadIssues({ symbol: "ATOMUSDT", positionAmt: "12.300", entryPrice: "4.512", markPrice: "0.00000000" });
    expect(issues).toHaveLength(1);
    expect(issues[0]).toContain("markPrice");
  });
  test('FLAT row with markPrice "0.00000000" is benign (documented testnet shape)', () => {
    expect(positionPayloadIssues({ symbol: "ATOMUSDT", positionAmt: "0.000", entryPrice: "0.0", markPrice: "0.00000000" })).toEqual([]);
  });
  test("open position with entryPrice 0 and non-numeric positionAmt are both flagged", () => {
    expect(positionPayloadIssues({ positionAmt: "0.5", entryPrice: "0.0", markPrice: "100" })).toHaveLength(1);
    expect(positionPayloadIssues({ positionAmt: "abc" })).toHaveLength(1);
  });
});

describe("clockDriftMs (round-trip-aware /fapi/v1/time skew)", () => {
  test("server ahead of the local midpoint → positive drift", () => {
    // t0=NOW, t1=NOW+400 (RTT 400ms), server says midpoint+123 → drift 123ms
    expect(clockDriftMs(NOW + 200 + 123, NOW, NOW + 400)).toBe(123);
  });
});

describe("ClockDriftMonitor (hftbacktest: min feed latency < 0 is impossible)", () => {
  test("sustained negative latency alerts ONCE per cooldown; re-alerts after", () => {
    const alerts: string[] = [];
    const mon = new ClockDriftMonitor(m => alerts.push(m));
    let t = NOW;
    // 2× MIN_SAMPLES samples all arriving "1.5s before they happened"
    for (let i = 0; i < DRIFT_MIN_SAMPLES * 2; i++) {
      mon.observe("binance_bookTicker", t + 1_500, t); // latency = -1500ms
      t += 1_000;
    }
    expect(alerts).toHaveLength(1); // aggregated, not one per event
    expect(alerts[0]).toContain("binance_bookTicker");
    // past the cooldown, the still-broken feed pages again
    t += DRIFT_ALERT_COOLDOWN_MS;
    for (let i = 0; i < DRIFT_MIN_SAMPLES; i++) { mon.observe("binance_bookTicker", t + 1_500, t); t += 1_000; }
    expect(alerts).toHaveLength(2);
  });

  test("small negative latency (jitter within tolerance) and positive latency never alert", () => {
    const alerts: string[] = [];
    const mon = new ClockDriftMonitor(m => alerts.push(m));
    let t = NOW;
    for (let i = 0; i < DRIFT_MIN_SAMPLES * 2; i++) {
      mon.observe("jitter", t + NEGATIVE_LATENCY_TOLERANCE_MS / 2, t); // -500ms: granularity, not desync
      mon.observe("healthy", t - 80, t);                               // normal +80ms latency
      t += 1_000;
    }
    expect(alerts).toEqual([]);
  });

  test("a single spike below MIN_SAMPLES does not alert (sustained only)", () => {
    const alerts: string[] = [];
    const mon = new ClockDriftMonitor(m => alerts.push(m));
    mon.observe("spike", NOW + 10_000, NOW); // one wildly negative sample
    expect(alerts).toEqual([]);
    expect(mon.minLatency("spike")).toBe(-10_000);
  });
});

describe("warnThrottled (aggregated alerts — alert fatigue is documented history)", () => {
  beforeEach(() => resetWarnThrottle());

  test("fires once, suppresses inside cooldown, re-fires after with suppressed count", () => {
    expect(warnThrottled("k", "msg", WARN_COOLDOWN_MS, NOW)).toBe(true);
    expect(warnThrottled("k", "msg", WARN_COOLDOWN_MS, NOW + 1_000)).toBe(false);
    expect(warnThrottled("k", "msg", WARN_COOLDOWN_MS, NOW + 2_000)).toBe(false);
    expect(warnThrottled("k", "msg", WARN_COOLDOWN_MS, NOW + WARN_COOLDOWN_MS + 1)).toBe(true);
  });

  test("independent keys do not throttle each other", () => {
    expect(warnThrottled("a", "msg", WARN_COOLDOWN_MS, NOW)).toBe(true);
    expect(warnThrottled("b", "msg", WARN_COOLDOWN_MS, NOW)).toBe(true);
  });
});
