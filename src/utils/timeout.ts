// ══════════════════════════════════════════════
// Network timeouts (2026-07-09) — a hung fetch with no timeout deadlocked the
// scan loop for 31h (this.scanning stuck true). Every network call in an
// interval-driven hot path MUST be bounded so a stalled connection can't hang
// a whole subsystem. Two helpers:
//   fetchT     — fetch() with an AbortController deadline (aborts the socket)
//   withTimeout — races any promise (e.g. an SDK call we can't abort) so the
//                 caller unblocks; the underlying op may keep running but the
//                 caller returns/throws instead of hanging forever.
// ══════════════════════════════════════════════

export async function fetchT(url: string, opts: RequestInit = {}, timeoutMs = 10_000): Promise<Response> {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(new Error(`fetch timeout ${timeoutMs}ms`)), timeoutMs);
  try {
    return await fetch(url, { ...opts, signal: ctrl.signal });
  } finally {
    clearTimeout(t);
  }
}

/** Race `p` against a timeout. On timeout, rejects (does NOT cancel `p`). Use
 *  for SDK calls that have no AbortSignal so the caller can't hang forever. */
export function withTimeout<T>(p: Promise<T>, timeoutMs: number, label = "op"): Promise<T> {
  let t: ReturnType<typeof setTimeout> | undefined;
  return Promise.race([
    p,
    new Promise<T>((_, rej) => {
      t = setTimeout(() => rej(new Error(`${label} timeout ${timeoutMs}ms`)), timeoutMs);
    }),
  ]).finally(() => clearTimeout(t));
}
