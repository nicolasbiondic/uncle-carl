// Which models review, which replace them, and the quota gate (pre-registration §3.2 and the machine's
// policy, ~/.config/opencode/notes/modelos-y-cuotas.md). Pure: `cuotas-ia --json` is parsed here and
// run elsewhere. Enforced: src/ai-review/models.test.ts.

/** The panel size: the owner sees "N de 3 modelos". */
export const PANEL_SIZE = 3;

export const PRIMARIES: readonly string[] = [
  "anthropic/claude-sonnet-5-5",
  "codex/gpt-6.1-sol",
  "antigravity/gemini-3.8-flash-high",
];
/** In this order, for a primary whose quota is closed or that fails. */
export const SUBSTITUTES: readonly string[] = [
  "opencode-go/kimi-k3.1-pro",
  "opencode-go/qwen3.8-max",
  "opencode/deepseek-v4.1-flash-free",
];

/** Policy thresholds: a window at or above these closes its quota (percent used). */
export const CLOSE_5H = 80;
export const CLOSE_WEEK = 85;
export const CLOSE_GEMINI = 90;

type Pool = "Claude" | "Codex" | "Google";
interface ModelInfo { family: string; pool: Pool | null; window?: string; closeAt?: number }

// pool null = not in `cuotas-ia` (OpenCode Go is monthly per model, Zen free has no limit): always open here.
const INFO: Readonly<Record<string, ModelInfo>> = {
  "anthropic/claude-sonnet-5-5": { family: "claude", pool: "Claude" },
  "anthropic/claude-haiku-5-5": { family: "claude", pool: "Claude" },
  "codex/gpt-6.1-sol": { family: "gpt", pool: "Codex" },
  "antigravity/gemini-3.8-flash-high": { family: "gemini", pool: "Google", window: "Gemini", closeAt: CLOSE_GEMINI },
  "opencode-go/kimi-k3.1-pro": { family: "kimi", pool: null },
  "opencode-go/qwen3.8-max": { family: "qwen", pool: null },
  "opencode/deepseek-v4.1-flash-free": { family: "deepseek", pool: null },
};

export function infoOf(model: string): ModelInfo {
  return INFO[model] ?? { family: model.split("/")[0], pool: null };
}
export const familyOf = (model: string): string => infoOf(model).family;

export interface QuotaWindow { nombre: string; clase: string; usado: number }
export interface QuotaAccount { error: string | null; ventanas: QuotaWindow[] }
export type QuotaReport = Record<string, QuotaAccount[]>;

/** `cuotas-ia --json` → pools. null when the output is not what we know (the caller then tries the primaries anyway). */
export function parseQuota(text: string): QuotaReport | null {
  try {
    const j = JSON.parse(text);
    if (!j || typeof j !== "object" || !j.pools || typeof j.pools !== "object") return null;
    const out: QuotaReport = {};
    for (const [pool, accounts] of Object.entries(j.pools as Record<string, unknown>)) {
      if (!Array.isArray(accounts)) continue;
      out[pool] = accounts.map((a: any) => ({
        error: a && a.error ? String(a.error) : null,
        ventanas: Array.isArray(a?.ventanas) ? a.ventanas.filter((w: any) => w && typeof w.usado === "number").map((w: any) => ({ nombre: String(w.nombre), clase: String(w.clase), usado: w.usado })) : [],
      }));
    }
    return out;
  } catch { return null; }
}

export interface GateResult { open: boolean; why: string }

/**
 * Is the model's quota open? A pool is open when at least one of its accounts is; an account is open when no
 * window the model draws on is at its close threshold (5 h ≥ 80 %, week ≥ 85 %, Gemini ≥ 90 %).
 * `report` null (cuotas-ia failed) or a pool we cannot read → open ("try anyway"), the reason says so.
 */
export function gate(model: string, report: QuotaReport | null): GateResult {
  const info = infoOf(model);
  if (info.pool === null) return { open: true, why: "no cuotas-ia pool (monthly or free)" };
  if (report === null) return { open: true, why: "cuotas-ia unavailable, tried anyway" };
  const accounts = (report[info.pool] ?? []).filter(a => a.error === null);
  if (accounts.length === 0) return { open: true, why: `no readable ${info.pool} account, tried anyway` };
  const worst: string[] = [];
  for (const a of accounts) {
    const relevant = info.window
      ? a.ventanas.filter(w => w.nombre === info.window).map(w => ({ w, at: info.closeAt ?? CLOSE_WEEK }))
      : a.ventanas.filter(w => w.clase === "5h" || w.clase === "semana").map(w => ({ w, at: w.clase === "5h" ? CLOSE_5H : CLOSE_WEEK }));
    const hit = relevant.find(r => r.w.usado >= r.at);
    if (!hit) return { open: true, why: `${info.pool} open` };
    worst.push(`${hit.w.nombre} ${hit.w.usado} %`);
  }
  return { open: false, why: `${info.pool} quota closed (${[...new Set(worst)].join(", ")})` };
}
