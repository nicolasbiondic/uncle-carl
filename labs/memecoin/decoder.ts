/**
 * Decodificador en código puro (sin @solana/*) de las notificaciones
 * `logsSubscribe` del programa pump.fun: base64 → borsh → base58.
 *
 * Eventos Anchor (líneas `Program data: <base64>`), identificados por el
 * discriminador sha256("event:<Nombre>")[0..8]:
 *   TradeEvent    mint, sol_amount, token_amount, is_buy, user, timestamp,
 *                 virtual_sol_reserves, virtual_token_reserves,
 *                 real_sol_reserves, real_token_reserves,
 *                 fee_recipient, fee_basis_points, fee, creator,
 *                 creator_fee_basis_points, creator_fee, … (campos nuevos
 *                 al final que no se leen; longitudes vistas 390–439 bytes)
 *   CreateEvent   name, symbol, uri, mint, bonding_curve, user, creator,
 *                 timestamp, virtual_token_reserves, virtual_sol_reserves,
 *                 real_token_reserves, token_total_supply
 *   CompleteEvent user, mint, bonding_curve, timestamp  (graduación)
 * Layout verificado contra `fixtures/pump-logs-2026-11-10.json` (decoder.test.ts).
 *
 * Las transacciones con `err != null` (≈85 % del caudal: bots con slippage
 * fallido) se descartan ANTES de hacer JSON.parse, por una búsqueda de
 * subcadena en el frame crudo; el campo se vuelve a comprobar tras el parse.
 */

export interface TradeEvent {
  type: "trade";
  mint: string;
  solLamports: number;
  tokenRaw: number;
  isBuy: boolean;
  user: string;
  timestamp: number;
  vSol: number;
  vTok: number;
  rSol: number;
  rTok: number;
  /** Comisión total observada (protocolo + creador) en pb, si el evento la trae. */
  feeBps: number | null;
  /** Comisión total observada en lamports, si el evento la trae. */
  feeLamports: number | null;
}

export interface CreateEvent {
  type: "create";
  name: string;
  symbol: string;
  uri: string;
  mint: string;
  bondingCurve: string;
  user: string;
  creator: string;
  timestamp: number;
  vTok: number;
  vSol: number;
  rTok: number;
  totalSupply: number;
}

export interface CompleteEvent {
  type: "complete";
  user: string;
  mint: string;
  bondingCurve: string;
  timestamp: number;
}

export type PumpEvent = TradeEvent | CreateEvent | CompleteEvent;

export interface Notification {
  kind: "notification";
  slot: number;
  signature: string;
  events: PumpEvent[];
}
export interface Skipped {
  kind: "skip";
  reason: "failed_tx" | "no_events" | "not_notification" | "bad_json";
}
export interface Control {
  kind: "control";
  /** Respuesta a una petición (id) o error del RPC. */
  id: number | null;
  result: unknown;
  error: unknown;
}
export type ParsedFrame = Notification | Skipped | Control;

// ── base58 ───────────────────────────────────
const ALPHABET = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";

export function base58Encode(bytes: Uint8Array): string {
  if (bytes.length === 0) return "";
  const digits: number[] = [0];
  for (const byte of bytes) {
    let carry = byte;
    for (let j = 0; j < digits.length; j++) {
      carry += digits[j] << 8;
      digits[j] = carry % 58;
      carry = (carry / 58) | 0;
    }
    while (carry > 0) {
      digits.push(carry % 58);
      carry = (carry / 58) | 0;
    }
  }
  let out = "";
  for (const b of bytes) {
    if (b === 0) out += "1";
    else break;
  }
  // Los dígitos son little-endian; los ceros altos del valor no se escriben (ya cuentan los bytes 0 iniciales).
  let top = digits.length - 1;
  while (top > 0 && digits[top] === 0) top--;
  if (top === 0 && digits[0] === 0 && out.length > 0) return out;
  for (let i = top; i >= 0; i--) out += ALPHABET[digits[i]];
  return out;
}

// ── discriminadores ──────────────────────────
function eventDiscriminator(name: string): string {
  const h = new Bun.CryptoHasher("sha256");
  h.update(`event:${name}`);
  return Buffer.from(h.digest()).subarray(0, 8).toString("hex");
}

export const DISCRIMINATORS = {
  trade: eventDiscriminator("TradeEvent"),
  create: eventDiscriminator("CreateEvent"),
  complete: eventDiscriminator("CompleteEvent"),
} as const;

const DISC_TO_TYPE = new Map<string, PumpEvent["type"]>([
  [DISCRIMINATORS.trade, "trade"],
  [DISCRIMINATORS.create, "create"],
  [DISCRIMINATORS.complete, "complete"],
]);

/**
 * Pre-filtro barato (CPU): los 8 bytes del discriminador fijan los 10
 * primeros caracteres del base64 — se compara el prefijo ANTES de decodificar.
 */
const DISC_B64_PREFIXES: readonly string[] = Object.values(DISCRIMINATORS).map((hex) => Buffer.from(hex, "hex").toString("base64").slice(0, 10));
export function looksLikePumpEvent(base64: string): boolean {
  for (const p of DISC_B64_PREFIXES) if (base64.startsWith(p)) return true;
  return false;
}

// ── lector borsh ─────────────────────────────
class Reader {
  private o = 8; // tras el discriminador
  private dv: DataView;
  constructor(private buf: Buffer) {
    this.dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  }
  get remaining(): number {
    return this.buf.length - this.o;
  }
  pubkey(): string {
    const s = base58Encode(this.buf.subarray(this.o, this.o + 32));
    this.o += 32;
    return s;
  }
  u64(): number {
    const v = Number(this.dv.getBigUint64(this.o, true));
    this.o += 8;
    return v;
  }
  i64(): number {
    const v = Number(this.dv.getBigInt64(this.o, true));
    this.o += 8;
    return v;
  }
  bool(): boolean {
    return this.buf[this.o++] === 1;
  }
  string(): string {
    const len = this.dv.getUint32(this.o, true);
    this.o += 4;
    const s = this.buf.subarray(this.o, this.o + len).toString("utf8");
    this.o += len;
    return s;
  }
}

const TRADE_FIXED_LEN = 129; // hasta real_token_reserves incluido
const TRADE_WITH_FEES_LEN = 225; // hasta creator_fee incluido

/** Decodifica una línea `Program data:`; devuelve null si no es un evento conocido o está truncado. */
export function decodeProgramData(base64: string): PumpEvent | null {
  if (!looksLikePumpEvent(base64)) return null;
  let buf: Buffer;
  try {
    buf = Buffer.from(base64, "base64");
  } catch {
    return null;
  }
  if (buf.length < 8) return null;
  const type = DISC_TO_TYPE.get(buf.subarray(0, 8).toString("hex"));
  if (!type) return null;
  const r = new Reader(buf);
  try {
    if (type === "trade") {
      if (buf.length < TRADE_FIXED_LEN) return null;
      const mint = r.pubkey();
      const solLamports = r.u64();
      const tokenRaw = r.u64();
      const isBuy = r.bool();
      const user = r.pubkey();
      const timestamp = r.i64();
      const vSol = r.u64();
      const vTok = r.u64();
      const rSol = r.u64();
      const rTok = r.u64();
      let feeBps: number | null = null;
      let feeLamports: number | null = null;
      if (buf.length >= TRADE_WITH_FEES_LEN) {
        r.pubkey(); // fee_recipient
        const fBps = r.u64();
        const fee = r.u64();
        r.pubkey(); // creator
        const cBps = r.u64();
        const cFee = r.u64();
        if (fBps <= 10_000 && cBps <= 10_000) {
          feeBps = fBps + cBps;
          feeLamports = fee + cFee;
        }
      }
      return { type, mint, solLamports, tokenRaw, isBuy, user, timestamp, vSol, vTok, rSol, rTok, feeBps, feeLamports };
    }
    if (type === "create") {
      const name = r.string();
      const symbol = r.string();
      const uri = r.string();
      if (r.remaining < 32 * 4 + 8 * 5) return null;
      const mint = r.pubkey();
      const bondingCurve = r.pubkey();
      const user = r.pubkey();
      const creator = r.pubkey();
      const timestamp = r.i64();
      const vTok = r.u64();
      const vSol = r.u64();
      const rTok = r.u64();
      const totalSupply = r.u64();
      return { type, name, symbol, uri, mint, bondingCurve, user, creator, timestamp, vTok, vSol, rTok, totalSupply };
    }
    if (r.remaining < 32 * 3 + 8) return null;
    const user = r.pubkey();
    const mint = r.pubkey();
    const bondingCurve = r.pubkey();
    const timestamp = r.i64();
    return { type: "complete", user, mint, bondingCurve, timestamp };
  } catch {
    return null;
  }
}

const PROGRAM_DATA_PREFIX = "Program data: ";
const INVOKE_PREFIX = "Program ";
export const PUMP_PROGRAM = "6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P";

/**
 * Extrae los eventos pump.fun de la lista de logs de una transacción.
 * Sigue la pila de programas (`Program X invoke [n]` / `success` / `failed`)
 * y decodifica SOLO los `Program data:` emitidos con el programa pump.fun en
 * lo alto de la pila (una tx que menciona pump.fun puede traer eventos de
 * Jupiter u otros: ni se decodifican). Dentro de una tx se deduplica por
 * payload exacto (dos trades distintos nunca comparten reservas idénticas).
 */
export function extractEvents(logs: readonly string[], programId: string = PUMP_PROGRAM): PumpEvent[] {
  const out: PumpEvent[] = [];
  let seen: Set<string> | null = null;
  const stack: string[] = [];
  for (const line of logs) {
    if (line.startsWith(PROGRAM_DATA_PREFIX)) {
      if (stack.length > 0 && stack[stack.length - 1] !== programId) continue;
      const payload = line.slice(PROGRAM_DATA_PREFIX.length);
      if (!looksLikePumpEvent(payload)) continue;
      if (seen === null) seen = new Set();
      if (seen.has(payload)) continue;
      seen.add(payload);
      const ev = decodeProgramData(payload);
      if (ev) out.push(ev);
      continue;
    }
    if (!line.startsWith(INVOKE_PREFIX)) continue;
    // "Program <id> invoke [n]" | "Program <id> success" | "Program <id> failed: …" | "Program <id> consumed …" | "Program log: …"
    const sp = line.indexOf(" ", INVOKE_PREFIX.length);
    if (sp < 0) continue;
    const id = line.slice(INVOKE_PREFIX.length, sp);
    const rest = line.charCodeAt(sp + 1);
    if (rest === 105 /* i */ && line.startsWith("invoke", sp + 1)) stack.push(id);
    else if ((rest === 115 /* s */ && line.startsWith("success", sp + 1)) || (rest === 102 /* f */ && line.startsWith("failed", sp + 1))) {
      if (stack.length > 0 && stack[stack.length - 1] === id) stack.pop();
    }
  }
  return out;
}

/**
 * Parsea un frame crudo del WebSocket. Descarte temprano: una notificación
 * sin la subcadena `"err":null` es una transacción fallida y no se parsea.
 */
export function parseFrame(raw: string, programId: string = PUMP_PROGRAM): ParsedFrame {
  if (raw.includes('"logsNotification"')) {
    if (!raw.includes('"err":null')) return { kind: "skip", reason: "failed_tx" };
    if (!raw.includes(PROGRAM_DATA_PREFIX)) return { kind: "skip", reason: "no_events" };
  }
  let msg: any;
  try {
    msg = JSON.parse(raw);
  } catch {
    return { kind: "skip", reason: "bad_json" };
  }
  if (msg?.method === "logsNotification") {
    const value = msg.params?.result?.value;
    if (!value || value.err !== null || !Array.isArray(value.logs)) return { kind: "skip", reason: "failed_tx" };
    const events = extractEvents(value.logs, programId);
    if (events.length === 0) return { kind: "skip", reason: "no_events" };
    return { kind: "notification", slot: Number(msg.params?.result?.context?.slot ?? 0), signature: String(value.signature ?? ""), events };
  }
  if (msg && (msg.id !== undefined || msg.error !== undefined)) {
    return { kind: "control", id: typeof msg.id === "number" ? msg.id : null, result: msg.result, error: msg.error };
  }
  return { kind: "skip", reason: "not_notification" };
}

/**
 * El RPC público entrega casi cada transacción DOS veces (misma firma, mismo
 * slot; fixture 2026-11-10: 46 notificaciones, 31 firmas). Sin esto, cada
 * saldo de wallet y cada volumen se contaría doble. Conjunto acotado FIFO.
 */
export class SignatureDeduper {
  private readonly seen = new Set<string>();
  constructor(private readonly capacity = 100_000) {}
  /** true si la firma es nueva (y la registra); false si ya se había visto. Desalojo FIFO (orden de inserción del Set). */
  admit(signature: string): boolean {
    if (this.seen.has(signature)) return false;
    this.seen.add(signature);
    if (this.seen.size > this.capacity) {
      const oldest = this.seen.values().next().value as string;
      this.seen.delete(oldest);
    }
    return true;
  }
  has(signature: string): boolean {
    return this.seen.has(signature);
  }
  get size(): number {
    return this.seen.size;
  }
}
