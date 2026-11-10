/**
 * Feed `logsSubscribe` del programa pump.fun sobre un RPC WebSocket
 * (`MEMECOIN_RPC_WS`). Un solo socket; reconexión con backoff exponencial;
 * vigilancia de silencio (el programa emite cientos de tx/s: 20 s sin nada
 * = socket muerto); cada desconexión abre un HUECO que el lab registra y que
 * invalida las métricas de los tokens en seguimiento.
 *
 * El socket y los temporizadores se inyectan para los tests (sin red).
 */
export interface WebSocketLike {
  send(data: string): void;
  close(): void;
  onopen: ((ev: unknown) => void) | null;
  onmessage: ((ev: { data: unknown }) => void) | null;
  onclose: ((ev: { code?: number; reason?: string }) => void) | null;
  onerror: ((ev: unknown) => void) | null;
}

export interface FeedTimers {
  setTimeout(fn: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
}

export interface FeedOptions {
  url: string;
  programId: string;
  commitment: string;
  silenceTimeoutMs: number;
  backoff: { initial: number; max: number; factor: number };
  now: () => number;
  onFrame: (raw: string, receivedAt: number) => void;
  onGapStart: (at: number, reason: string) => void;
  onGapEnd: (at: number) => void;
  log: { info(m: string): void; warn(m: string): void; error(m: string): void };
  wsFactory?: (url: string) => WebSocketLike;
  timers?: FeedTimers;
}

export interface FeedStats {
  frames: number;
  bytes: number;
  connects: number;
  disconnects: number;
  startedAt: number;
}

export class PumpLogsFeed {
  readonly stats: FeedStats;
  private ws: WebSocketLike | null = null;
  private subscribed = false;
  private everSubscribed = false;
  private stopped = false;
  private attempt = 0;
  private silenceTimer: unknown = null;
  private reconnectTimer: unknown = null;
  private readonly timers: FeedTimers;
  private readonly wsFactory: (url: string) => WebSocketLike;

  constructor(private readonly o: FeedOptions) {
    this.timers = o.timers ?? { setTimeout: (fn, ms) => setTimeout(fn, ms), clearTimeout: (h) => clearTimeout(h as any) };
    this.wsFactory = o.wsFactory ?? ((url) => new WebSocket(url) as unknown as WebSocketLike);
    this.stats = { frames: 0, bytes: 0, connects: 0, disconnects: 0, startedAt: o.now() };
  }

  get connected(): boolean {
    return this.subscribed;
  }

  /** Temporizadores vivos (≤ 2 por construcción: silencio y reconexión). */
  get activeTimers(): number {
    return (this.silenceTimer ? 1 : 0) + (this.reconnectTimer ? 1 : 0);
  }

  /** Retardo de reconexión para el intento n (1-based), acotado. */
  backoffMs(attempt: number): number {
    const b = this.o.backoff;
    return Math.min(b.max, b.initial * Math.pow(b.factor, Math.max(0, attempt - 1)));
  }

  start(): void {
    this.stopped = false;
    this.connect();
  }

  stop(): void {
    this.stopped = true;
    this.clearTimers();
    const ws = this.ws;
    this.ws = null;
    if (ws) this.detach(ws);
    if (this.subscribed) {
      this.subscribed = false;
      this.o.onGapStart(this.o.now(), "stop");
    }
  }

  /** Desengancha todos los handlers y cierra: un socket viejo nunca sigue vivo ni duplica handlers. */
  private detach(ws: WebSocketLike): void {
    ws.onopen = null;
    ws.onmessage = null;
    ws.onclose = null;
    ws.onerror = null;
    try {
      ws.close();
    } catch {}
  }

  private connect(): void {
    if (this.stopped) return;
    if (this.ws) this.detach(this.ws); // defensa: nunca dos sockets a la vez
    this.ws = null;
    this.attempt++;
    this.stats.connects++;
    let ws: WebSocketLike;
    try {
      ws = this.wsFactory(this.o.url);
    } catch (e) {
      this.o.log.error(`no se pudo crear el socket: ${String(e)}`);
      this.scheduleReconnect();
      return;
    }
    this.ws = ws;
    ws.onopen = () => {
      ws.send(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "logsSubscribe", params: [{ mentions: [this.o.programId] }, { commitment: this.o.commitment }] }));
      this.armSilence();
    };
    ws.onmessage = (ev) => {
      if (this.ws !== ws) return; // mensaje tardío de un socket ya sustituido
      const raw = typeof ev.data === "string" ? ev.data : String(ev.data);
      const at = this.o.now();
      this.stats.frames++;
      this.stats.bytes += raw.length;
      this.armSilence();
      if (!this.subscribed && raw.includes('"id":1') && raw.includes('"result"')) {
        this.subscribed = true;
        this.attempt = 0;
        this.o.log.info(`suscrito a logs del programa (${this.o.url})`);
        if (this.everSubscribed) this.o.onGapEnd(at);
        this.everSubscribed = true;
        return;
      }
      if (raw.includes('"error"') && !raw.includes('"logsNotification"')) this.o.log.warn(`respuesta RPC con error: ${raw.slice(0, 200)}`);
      this.o.onFrame(raw, at);
    };
    ws.onerror = (e) => {
      this.o.log.warn(`error del socket: ${String((e as any)?.message ?? e)}`);
    };
    ws.onclose = (ev) => {
      if (this.ws !== ws) return;
      this.handleClose(`close ${ev?.code ?? ""} ${ev?.reason ?? ""}`.trim());
    };
  }

  private handleClose(reason: string): void {
    if (this.stopped) return;
    if (this.ws) this.detach(this.ws);
    this.ws = null;
    this.stats.disconnects++;
    if (this.silenceTimer) this.timers.clearTimeout(this.silenceTimer);
    this.silenceTimer = null;
    const wasSubscribed = this.subscribed;
    this.subscribed = false;
    if (wasSubscribed) this.o.onGapStart(this.o.now(), reason);
    this.o.log.warn(`socket cerrado (${reason}); reintento ${this.attempt + 1} en ${this.backoffMs(this.attempt + 1)} ms`);
    this.scheduleReconnect();
  }

  private scheduleReconnect(): void {
    if (this.stopped) return;
    const delay = this.backoffMs(this.attempt + 1);
    this.reconnectTimer = this.timers.setTimeout(() => {
      this.reconnectTimer = null;
      this.connect();
    }, delay);
  }

  private armSilence(): void {
    if (this.silenceTimer) this.timers.clearTimeout(this.silenceTimer);
    this.silenceTimer = this.timers.setTimeout(() => {
      this.silenceTimer = null;
      const ws = this.ws;
      if (!ws) return;
      this.o.log.warn(`silencio de ${this.o.silenceTimeoutMs} ms: se cierra el socket`);
      this.handleClose("silence");
    }, this.o.silenceTimeoutMs);
  }

  private clearTimers(): void {
    if (this.silenceTimer) this.timers.clearTimeout(this.silenceTimer);
    if (this.reconnectTimer) this.timers.clearTimeout(this.reconnectTimer);
    this.silenceTimer = null;
    this.reconnectTimer = null;
  }
}
