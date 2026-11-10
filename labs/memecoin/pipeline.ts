/**
 * Cola ACOTADA entre el socket y el lab. Si el procesado se atrasa, los
 * frames nuevos se descartan y se cuentan (y el lab abre un hueco: las
 * métricas de ese tramo no son exactas); nunca se acumulan. El drenado va
 * por lotes en turnos del event loop para que heartbeat y temporizadores
 * sigan corriendo bajo carga.
 */
import { parseFrame } from "./decoder";
import type { MemecoinLab } from "./lab";

export class FrameQueue {
  private buf: { raw: string; at: number }[] = [];
  private head = 0;
  dropped = 0;
  maxSeen = 0;
  constructor(readonly capacity: number) {}
  get size(): number {
    return this.buf.length - this.head;
  }
  push(raw: string, at: number): boolean {
    if (this.size >= this.capacity) {
      this.dropped++;
      return false;
    }
    this.buf.push({ raw, at });
    if (this.size > this.maxSeen) this.maxSeen = this.size;
    return true;
  }
  shift(): { raw: string; at: number } | undefined {
    if (this.size === 0) return undefined;
    const v = this.buf[this.head];
    this.buf[this.head] = undefined as unknown as { raw: string; at: number };
    this.head++;
    if (this.head >= 1_024 && this.head * 2 >= this.buf.length) {
      this.buf = this.buf.slice(this.head);
      this.head = 0;
    }
    return v;
  }
}

export interface PipelineStats {
  frames: number;
  notifications: number;
  skippedFailed: number;
  skippedNoEvents: number;
  dropped: number;
  queueMax: number;
}

export class Pipeline {
  readonly queue: FrameQueue;
  readonly stats: PipelineStats = { frames: 0, notifications: 0, skippedFailed: 0, skippedNoEvents: 0, dropped: 0, queueMax: 0 };
  private scheduled = false;
  private overflowing = false;

  constructor(
    private readonly lab: MemecoinLab,
    private readonly o: { capacity: number; drainBatch: number; programId: string; schedule?: (fn: () => void) => void },
  ) {
    this.queue = new FrameQueue(o.capacity);
  }

  /** Entrada desde el socket (síncrona y barata: encolar y programar el drenado). */
  onFrame(raw: string, at: number): void {
    this.stats.frames++;
    if (!this.queue.push(raw, at)) {
      this.stats.dropped++;
      if (!this.overflowing) {
        this.overflowing = true;
        this.lab.onGapStart(at, "queue_overflow");
      }
    }
    this.scheduleDrain();
  }

  private scheduleDrain(): void {
    if (this.scheduled) return;
    this.scheduled = true;
    const run = () => {
      this.scheduled = false;
      this.drain(this.o.drainBatch);
      if (this.queue.size > 0) this.scheduleDrain();
    };
    if (this.o.schedule) this.o.schedule(run);
    else setImmediate(run);
  }

  /** Procesa hasta `max` frames; devuelve cuántos procesó. */
  drain(max: number): number {
    let n = 0;
    let last = 0;
    while (n < max) {
      const f = this.queue.shift();
      if (!f) break;
      n++;
      last = f.at;
      const p = parseFrame(f.raw, this.o.programId);
      if (p.kind === "notification") {
        this.stats.notifications++;
        this.lab.onNotification(p, f.at);
      } else if (p.kind === "skip") {
        if (p.reason === "failed_tx") this.stats.skippedFailed++;
        else this.stats.skippedNoEvents++;
      }
    }
    if (this.queue.size > this.stats.queueMax) this.stats.queueMax = this.queue.size;
    if (this.overflowing && this.queue.size === 0) {
      this.overflowing = false;
      this.lab.onGapEnd(last);
    }
    return n;
  }
}
