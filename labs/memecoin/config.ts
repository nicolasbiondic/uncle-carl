/**
 * Configuración PRE-REGISTRADA del laboratorio de memecoins (paper).
 *
 * Todo número que influye en una decisión o en una simulación vive aquí y
 * en ningún otro sitio. El lab guarda `STRATEGY_VERSION` y `configHash()` en
 * cada decisión y cada operación, de modo que un cambio de parámetros se ve
 * en la base de datos como una versión nueva, nunca como una edición
 * silenciosa de la historia. Cambiar la estrategia = cambiar la versión.
 *
 * Unidades: tiempos en ms, SOL en SOL (no lamports), porcentajes como
 * fracciones salvo que el nombre diga `Pct` (puntos porcentuales) o `Bps`.
 */

export const STRATEGY_VERSION = "fomo-momentum@v1";

/** Programa de pump.fun en mainnet (fuente de los eventos TradeEvent/CreateEvent/CompleteEvent). */
export const PUMP_PROGRAM_ID = "6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P";

const BASE_CONFIG = {
  feed: {
    /** RPC WebSocket (variable de entorno MEMECOIN_RPC_WS; por defecto el público). Una API key de
     *  Helius/QuickNode es una key, no una wallet: se cambia solo esta URL. */
    rpcWsDefault: "wss://api.mainnet-beta.solana.com",
    commitment: "processed",
    /** Sin ningún mensaje durante este tiempo el socket se da por muerto (el programa emite >100 tx/s). */
    silenceTimeoutMs: 20_000,
    reconnectBackoffMs: { initial: 1_000, max: 60_000, factor: 2 },
    heartbeatIntervalMs: 30_000,
    /** Cola de frames entre el socket y el procesado: si se llena, se DESCARTA (y cuenta como hueco), nunca se acumula. */
    maxQueuedFrames: 5_000,
    /** Frames procesados por turno del event loop (deja respirar a los temporizadores). */
    drainBatch: 500,
  },
  limits: {
    /** Tokens en seguimiento a la vez; al superarlo se desaloja el más antiguo (se cierra su ventana antes de tiempo). */
    maxTrackedTokens: 2_000,
    /** Wallets con saldo por token; al superarlo las métricas dejan de ser exactas (token marcado, descartado como data_gap). */
    maxWalletsPerToken: 5_000,
    /** Trades recientes en memoria por token (además del límite temporal `tradeHistoryMs`). */
    maxTradesPerToken: 3_000,
    /** Muestras del rastro de precios por token (≤ 1/s durante la ventana de candidatura). */
    maxTrailPerToken: 1_000,
    /** Desenlaces pendientes vigilados (≤ 24 h cada uno); al superarlo se cierra el más antiguo con lo que tenga. */
    maxOutcomeWatches: 20_000,
    /** Firmas recordadas para deduplicar (el RPC repite casi cada tx). */
    maxDedupeSignatures: 100_000,
    /** Mints ya operados (sin re-entrada); FIFO. */
    maxTradedMints: 10_000,
    /** Filas crudas pendientes de escribir; por encima se descartan las más viejas. */
    maxRawBuffer: 20_000,
    /** RSS máximo del proceso: por encima se registra ERROR y se sale con código ≠ 0 (systemd reinicia). */
    maxRssMb: 400,
  },
  tracking: {
    /** Ventana en la que se reconstruyen los saldos de cada wallet desde la creación. */
    trackWindowMs: 30 * 60_000,
    /** Trades guardados en memoria por token (para las métricas de flujo). */
    tradeHistoryMs: 5 * 60_000,
    /** Horizontes del desenlace de todo candidato. */
    outcomeHorizonsMs: [5 * 60_000, 60 * 60_000, 24 * 60 * 60_000] as readonly number[],
    /** Caída desde el precio de la decisión que cuenta como rug a +24 h. */
    rugDrawdown: 0.9,
    /** Eventos crudos: retención en días (agregados: para siempre). */
    rawRetentionDays: 7,
  },
  sim: {
    /** Latencia decisión → ejecución: la orden se llena contra el PRIMER trade observado en t + D. */
    latencyMs: 1_500,
    /** Una compra sin trade posterior en este plazo se cancela (no se inventa liquidez). */
    buyFillTimeoutMs: 30_000,
    /** Una venta sin trade posterior en este plazo se llena contra el último estado real (token muerto). */
    sellDeadTimeoutMs: 30_000,
    /** Suelo de la comisión de pump.fun (protocolo + creador). Observado 2026-11-10: 95 + 30 = 125 pb típicos,
     *  hasta 395 en algunos tokens; se usa el MAYOR entre lo observado en el trade de referencia y este suelo. */
    pumpFeeBpsFloor: 125,
    /** Base fee + priority fee por transacción, en SOL (fijo, conservador). */
    txFeeSol: 0.001,
    /** Recargo MEV/sándwich por lado (fracción del SOL movido). */
    mevPerSide: 0.01,
    /** Tras la migración a PumpSwap: salida forzada al último precio de curva menos este recargo. */
    migrationExitPenalty: 0.25,
    /** No entrar si la curva ya tiene este SOL real (graduación ≈ 85 SOL): evita quedar atrapado en la migración. */
    noEntryAboveRealSol: 60,
  },
  account: {
    initialSol: 10,
  },
  strategy: {
    /** Candidato: edad desde el CreateEvent dentro de [min, max]. */
    ageMinMs: 30_000,
    ageMaxMs: 15 * 60_000,
    /** Mínimo de trades para evaluar siquiera un token (los muertos no son candidatos). */
    minTradesForCandidate: 5,
    /** Filtros de descarte. */
    filters: {
      /** Top 10 holders (sin la curva) ≤ esta fracción de los tokens en circulación. */
      top10MaxShare: 0.2,
      /** Wallets que compraron en los primeros `earlyWindowMs` tras la creación ≤ esta fracción. */
      earlyWalletsMaxShare: 0.3,
      earlyWindowMs: 2_000,
      /** El dev (creator) no ha vendido nada. */
      devMustNotSell: true,
      /** Volumen acumulado (compras + ventas) ≥ este SOL. */
      minVolumeSol: 5,
      /** Mínimo de holders con saldo > 0. */
      minHolders: 15,
    },
    /** Condición de entrada sobre los últimos `windowMs`. */
    entry: {
      windowMs: 60_000,
      /** A: SOL neto comprado (compras − ventas). */
      netBuySolMin: 2,
      /** N: compradores únicos. */
      uniqueBuyersMin: 8,
      /** R: ratio nº compras / nº ventas. */
      buySellRatioMin: 2,
      /** Score 0–1 (ver `scoreCandidate` en strategy.ts) ≥ umbral. */
      scoreThreshold: 0.6,
      /** Pesos del score (suman 1). */
      scoreWeights: { netBuy: 0.35, buyers: 0.25, ratio: 0.2, dispersion: 0.2 },
    },
    sizing: {
      /** Fracción del saldo de caja por entrada. */
      fractionOfBalance: 0.08,
      /** K posiciones simultáneas como máximo. */
      maxPositions: 3,
      /** Tamaño mínimo (si la caja no da, no se entra). */
      minOrderSol: 0.05,
    },
    exits: {
      /** Stop: caída del valor EJECUTABLE (venta neta de costes) respecto al valor ejecutable justo tras el fill,
       *  en puntos porcentuales del coste. Los costes de ida y vuelta (≈5 %: comisión ×2, MEV ×2, impacto de la
       *  propia venta) se pagan en el P&L pero no cuentan como "caída": si contaran, todo fill saltaría el stop
       *  en el acto. Se registra el gap real entre el nivel y el fill. */
      stopPct: -6,
      /** El trailing se activa cuando el P&L ejecutable alcanza este nivel… */
      trailingActivatePct: 12,
      /** …y cierra si cae estos puntos desde el máximo ejecutable. */
      trailingDropPct: 8,
      /** Toma de ganancia escalonada (fracción de la posición original en cada nivel). Vacío = desactivada. */
      takeProfit: [{ atPct: 30, fraction: 0.5 }] as readonly { atPct: number; fraction: number }[],
      /** Salir si el dev vende. */
      exitOnDevSell: true,
      /** Salir si el flujo neto se da la vuelta: SOL neto en los últimos `reversalWindowMs` ≤ −reversalNetSol. */
      reversalWindowMs: 30_000,
      reversalNetSol: 1,
      /** Time stop. */
      timeStopMs: 10 * 60_000,
      /** Regla del dueño: ninguna posición abierta más de 5 días (aserción dura, nunca debe llegar). */
      hardMaxHoldMs: 5 * 24 * 60 * 60_000,
      /** Sin re-entrar en un token tras un stop; sin promediar a la baja (una posición por token, sin añadidos). */
      noReentryAfterStop: true,
    },
  },
} as const;

/** Tipo ensanchado (los literales de `as const` impedirían configs alternativas en tests). */
type Widen<T> = T extends number ? number : T extends string ? string : T extends boolean ? boolean : T extends readonly (infer U)[] ? readonly Widen<U>[] : { readonly [K in keyof T]: Widen<T[K]> };
export type LabConfig = Widen<typeof BASE_CONFIG>;
export const LAB_CONFIG: LabConfig = BASE_CONFIG;

/** Hash corto y estable de la configuración (se guarda con cada decisión y operación). */
export function configHash(cfg: LabConfig = LAB_CONFIG): string {
  const h = new Bun.CryptoHasher("sha256");
  h.update(JSON.stringify(cfg));
  return h.digest("hex").slice(0, 12);
}
