import { describe, test, expect } from "bun:test";
import {
  OrderStateMachine, isValidTransition, fromBrokerStatus,
} from "./OrderStateMachine";

describe("isValidTransition", () => {
  test("SUBMITTING → OPEN is valid", () => {
    expect(isValidTransition("SUBMITTING", "OPEN")).toBe(true);
  });

  test("SUBMITTING → FILLED is valid (synchronous fill)", () => {
    expect(isValidTransition("SUBMITTING", "FILLED")).toBe(true);
  });

  test("OPEN → PARTIAL is valid", () => {
    expect(isValidTransition("OPEN", "PARTIAL")).toBe(true);
  });

  test("PARTIAL → FILLED is valid", () => {
    expect(isValidTransition("PARTIAL", "FILLED")).toBe(true);
  });

  test("FILLED → anything is invalid (terminal)", () => {
    expect(isValidTransition("FILLED", "CANCELED")).toBe(false);
    expect(isValidTransition("FILLED", "OPEN")).toBe(false);
  });

  test("OPEN → SUBMITTING is invalid (no going back)", () => {
    expect(isValidTransition("OPEN", "SUBMITTING")).toBe(false);
  });

  test("REJECTED → anything is invalid (terminal)", () => {
    expect(isValidTransition("REJECTED", "OPEN")).toBe(false);
    expect(isValidTransition("REJECTED", "FILLED")).toBe(false);
  });
});

describe("fromBrokerStatus", () => {
  test("Alpaca 'new' → OPEN", () => expect(fromBrokerStatus("new")).toBe("OPEN"));
  test("Alpaca 'partially_filled' → PARTIAL", () =>
    expect(fromBrokerStatus("partially_filled")).toBe("PARTIAL"));
  test("Alpaca 'filled' → FILLED", () => expect(fromBrokerStatus("filled")).toBe("FILLED"));
  test("Alpaca 'canceled' → CANCELED", () => expect(fromBrokerStatus("canceled")).toBe("CANCELED"));
  test("Alpaca 'cancelled' (UK spelling) → CANCELED", () =>
    expect(fromBrokerStatus("cancelled")).toBe("CANCELED"));
  test("Alpaca 'expired' → EXPIRED", () => expect(fromBrokerStatus("expired")).toBe("EXPIRED"));
  test("Alpaca 'done_for_day' → EXPIRED", () =>
    expect(fromBrokerStatus("done_for_day")).toBe("EXPIRED"));
  test("Alpaca 'rejected' → REJECTED", () => expect(fromBrokerStatus("rejected")).toBe("REJECTED"));
  test("Binance 'PARTIALLY_FILLED' → PARTIAL", () =>
    expect(fromBrokerStatus("PARTIALLY_FILLED")).toBe("PARTIAL"));
  test("Binance 'FILLED' → FILLED", () =>
    expect(fromBrokerStatus("FILLED")).toBe("FILLED"));
  test("internal 'pending' → SUBMITTING", () =>
    expect(fromBrokerStatus("pending")).toBe("SUBMITTING"));
  test("internal 'timeout_cancelled' → CANCELED", () =>
    expect(fromBrokerStatus("timeout_cancelled")).toBe("CANCELED"));
  test("unknown string → null", () => expect(fromBrokerStatus("weird")).toBeNull());
  test("null/undefined → null", () => {
    expect(fromBrokerStatus(null)).toBeNull();
    expect(fromBrokerStatus(undefined)).toBeNull();
    expect(fromBrokerStatus("")).toBeNull();
  });
});

describe("OrderStateMachine", () => {
  test("first transition sets state regardless of value", () => {
    const m = new OrderStateMachine();
    const r = m.transition("o1", "OPEN");
    expect(r.ok).toBe(true);
    expect(m.current("o1")).toBe("OPEN");
  });

  test("rejects invalid transitions and preserves state", () => {
    const m = new OrderStateMachine();
    m.transition("o1", "FILLED");
    const r = m.transition("o1", "OPEN");
    expect(r.ok).toBe(false);
    expect(r.from).toBe("FILLED");
    expect(m.current("o1")).toBe("FILLED");
  });

  test("PARTIAL → PARTIAL is allowed (incremental fills)", () => {
    const m = new OrderStateMachine();
    m.transition("o1", "OPEN");
    m.transition("o1", "PARTIAL");
    const r = m.transition("o1", "PARTIAL");
    expect(r.ok).toBe(true);
  });

  test("forget() removes the order", () => {
    const m = new OrderStateMachine();
    m.transition("o1", "FILLED");
    m.forget("o1");
    expect(m.current("o1")).toBeUndefined();
  });

  test("size reflects in-memory entries", () => {
    const m = new OrderStateMachine();
    expect(m.size()).toBe(0);
    m.transition("o1", "OPEN");
    m.transition("o2", "OPEN");
    expect(m.size()).toBe(2);
    m.forget("o1");
    expect(m.size()).toBe(1);
  });

  test("typical successful lifecycle", () => {
    const m = new OrderStateMachine();
    expect(m.transition("o1", "SUBMITTING").ok).toBe(true);
    expect(m.transition("o1", "OPEN").ok).toBe(true);
    expect(m.transition("o1", "PARTIAL").ok).toBe(true);
    expect(m.transition("o1", "FILLED").ok).toBe(true);
    expect(m.current("o1")).toBe("FILLED");
  });

  test("typical rejected lifecycle", () => {
    const m = new OrderStateMachine();
    m.transition("o1", "SUBMITTING");
    const r = m.transition("o1", "REJECTED");
    expect(r.ok).toBe(true);
    expect(m.current("o1")).toBe("REJECTED");
  });
});
