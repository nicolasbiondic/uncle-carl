// Per-sleeve gross-exposure cap, exactly as each engine was built with it:
// index.ts registers incumbent plans' maxGrossExposureMult; live/wiring.ts
// registers a successfully built LIVE portfolio engine's strategy.maxGross.
// Each registration includes the base the engine
// multiplies it by — MomentumEngine checks against the sleeve's CURRENT
// equity, MeanRevEngine against its allocation (baseUsd).
// AccountManager.getAccountSummaries ships both to the dashboard, whose
// exposure chips colour each sleeve by its share of its OWN cap
// (positions.js sleeveExposure). Display only: nothing that trades reads this.

export type GrossCapBase = "equity" | "allocation";

const caps = new Map<string, { mult: number; base: GrossCapBase }>();

export function registerGrossCap(sleeveId: string, mult: number | undefined, base: GrossCapBase): void {
  if (typeof mult === "number" && Number.isFinite(mult) && mult > 0) caps.set(sleeveId, { mult, base });
  else caps.delete(sleeveId); // a replacement with no declared cap must not retain the retired engine's
}

export function grossCapOf(sleeveId: string): { mult: number; base: GrossCapBase } | null {
  return caps.get(sleeveId) ?? null;
}

export function resetGrossCapsForTests(): void {
  caps.clear();
}
