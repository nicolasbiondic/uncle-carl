// Which broker-registry accounts the bot depends on: the ones the RUNNING
// process resolved at boot (ACCOUNTS_SOURCE=registry, set by index.ts) and
// the ones the configuration links (RUNTIME_ACCOUNT_* env > instance.json
// runtimeAccounts), which the NEXT boot will look for.
//
// Removing or revoking such an account from the dashboard leaves that boot
// without the venue; with open positions it refuses to start (src/index.ts,
// abandoned-exposure guard) — so the accounts API refuses those actions until
// the owner points the link elsewhere and restarts.
import { loadInstanceConfig } from "../instance";

let bootResolved = new Set<string>();

export function setRuntimeLinkedAccounts(ids: Array<string | null | undefined>): void {
  bootResolved = new Set(ids.filter((x): x is string => typeof x === "string" && x.length > 0));
}

/** Why an account cannot be removed or revoked right now, or null. */
export function runtimeLinkReason(id: string): string | null {
  if (bootResolved.has(id)) {
    return `the running bot signs with '${id}' — link another account (RUNTIME_ACCOUNT_ALPACA / RUNTIME_ACCOUNT_BINANCE or instance.json runtimeAccounts), restart, then remove it`;
  }
  const links = loadInstanceConfig().runtimeAccounts;
  if (links.alpaca === id || links.binance === id) {
    return `'${id}' is the configured runtime link (RUNTIME_ACCOUNT_* or instance.json runtimeAccounts) — the next boot would look for it; change the link first`;
  }
  return null;
}

export function isRuntimeLinked(id: string): boolean {
  return runtimeLinkReason(id) !== null;
}

export function resetRuntimeLinksForTests(): void {
  bootResolved = new Set();
}
