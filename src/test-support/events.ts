// Test-support: event-bus capture helpers. TEST-ONLY.
import { eventBus, EVENTS } from "../utils/events";

/** Collect ERROR_BURST payloads (optionally filtered by context prefix).
 *  Always call detach() — in a finally block if the body can throw —
 *  or the listener leaks into the next test. */
export function captureBursts(contextPrefix?: string): { bursts: any[]; detach: () => void } {
  const bursts: any[] = [];
  const handler = (d: any) => {
    if (!contextPrefix || String(d?.context ?? "").startsWith(contextPrefix)) bursts.push(d);
  };
  eventBus.on(EVENTS.ERROR_BURST, handler);
  return { bursts, detach: () => eventBus.removeListener(EVENTS.ERROR_BURST, handler) };
}

/** Same capture contract for any other bus event (POSITION_CLOSED, …). */
export function captureEvent(event: string): { events: any[]; detach: () => void } {
  const events: any[] = [];
  const handler = (d: any) => events.push(d);
  eventBus.on(event, handler);
  return { events, detach: () => eventBus.removeListener(event, handler) };
}
