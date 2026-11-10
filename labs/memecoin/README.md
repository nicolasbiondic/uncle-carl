# Laboratorio de memecoins (paper) — `labs/memecoin/`

Cuenta de **papel** que prueba una estrategia FOMO-momentum sobre tokens
recién lanzados en pump.fun (Solana): entrar en el FOMO y salir a tiempo.
Vive aislado del bot: proceso propio (`bun labs/memecoin/main.ts`), base
SQLite propia (`data/memecoin-lab.db`), unidad systemd propia
(`memecoin-lab.service`). Del código del bot solo importa `src/utils/logger`.

## Qué NO hace (y el test que lo hace cumplir)

- **No es dinero real.** No hay wallet, ni clave, ni firma, ni envío de
  transacciones. `enforcement.test.ts` falla si cualquier archivo de esta
  carpeta contiene las palabras de firma/wallet habituales o importa las
  librerías `@solana/*`, o si `package.json` las añade como dependencia.
- **No se apaga ni se pausa por pérdidas** (regla del dueño): no existe ningún
  parámetro de pausa; el riesgo se controla por tamaño (8 % de la caja, K = 3
  posiciones). `enforcement.test.ts`.
- **Ninguna posición vive más de 5 días**: time stop de 10 min y aserción dura
  de 5 días (`lab.assertMaxHold`, `lab.test.ts`).
- **No usa el motor de trading del bot**: `enforcement.test.ts` ("aislamiento").

## Datos: de dónde salen y qué cuestan

PumpPortal cobra hoy el stream por token (`subscribeTokenTrade`: 0,01 SOL por
10 000 eventos y API key = wallet con fondos), así que el lab lee **los logs del
programa pump.fun directamente del RPC** (`logsSubscribe` con
`mentions: [6EF8…F6P]`, commitment `processed`) y decodifica los eventos Anchor
en código puro (base64 → borsh → base58, `decoder.ts`; layout verificado con
`fixtures/pump-logs-2026-11-10.json`, logs públicos capturados ese día):

| Evento | Campos que se usan |
|---|---|
| `TradeEvent` | mint, sol_amount, token_amount, is_buy, user, virtual_sol/token_reserves, real_sol/token_reserves, fee_basis_points + creator_fee_basis_points (si vienen) |
| `CreateEvent` | name, symbol, mint, creator (dev), reservas virtuales iniciales, supply |
| `CompleteEvent` | mint (graduación/migración a PumpSwap) |

- RPC configurable por `MEMECOIN_RPC_WS` en `.env` (por defecto el público de
  mainnet-beta). Una API key gratuita de Helius/QuickNode es una key, no una
  wallet: se cambia solo la URL.
- **Coste medido** (prueba de 3 min, 2026-11-10): ~400–700 frames/s,
  **≈ 58–90 GB/día de entrada**; el 77 % son transacciones fallidas (bots con
  slippage) que se descartan por una búsqueda de subcadena ANTES de parsear, y
  el RPC público entrega casi cada transacción dos veces (se deduplica por
  firma). CPU media del proceso 2,8 %; RSS 35–55 MB.
- Las constantes de la curva se leen del `CreateEvent` de cada token (hay
  curvas atípicas con < 1 SOL virtual, p. ej. quote distinto de SOL vía router:
  se descartan como `curve_atypical`). pump.fun no expone autoridad mint/freeze
  en eventos; sus tokens nacen sin ellas, el filtro es vacío.
- Un hueco del feed (desconexión, silencio > 20 s, cola llena) invalida las
  métricas de todos los tokens en seguimiento (`data_gap`) y marca las
  posiciones abiertas; no se inventa nada. Reconexión con backoff 1→60 s, un
  único socket vivo (`soak.test.ts`).

## Simulador: por qué el paper no miente (y en qué sobreestima igualmente)

- Precio = curva de producto constante sobre las **reservas virtuales reales**
  del trade de referencia.
- **Latencia**: una orden decidida en t se llena contra el estado del **primer
  trade observado en t + 1,5 s** (`sim.latencyMs`). Compra sin trade en 30 s:
  cancelada (no hay liquidez observada). Venta sin trade en 30 s: se llena
  contra el **último estado real** (token muerto; un rug se paga entero).
- **Costes**, todos en `config.ts`: comisión de pump.fun = máx(observada en el
  trade de referencia, suelo 1,25 %; hoy 0,95 % protocolo + 0,30 % creador),
  0,001 SOL de fee por tx, 1 % de MEV por lado.
- **Migración** con posición abierta: salida forzada al último precio de curva
  menos 25 %; además no se entra si la curva ya tiene ≥ 60 SOL reales.
- **Stop**: −6 pp del valor ejecutable respecto al valor ejecutable justo tras
  el fill. Los costes de ida y vuelta (≈ 5–7 %, incluida la venta de los
  propios tokens en la curva) se pagan en el P&L pero no cuentan como caída: si
  contaran, todo fill saltaría el stop en el acto. El gap entre el nivel y el
  fill real queda registrado por operación (`stop_gap_pct`).
- **Lo que no modela** (sobreestima): el impacto de nuestra orden sobre los
  trades ajenos posteriores, transacciones fallidas por slippage, congestión y
  priority fees variables, el precio tras la migración, y que la cuenta paper
  "siempre consigue" el fill al primer trade. Los retornos del apartado
  APRENDIZAJE son de **precio**, sin costes.

## Estrategia v1 (pre-registrada en `config.ts`, versión `fomo-momentum@v1`)

Candidato: edad 30 s–15 min, ≥ 5 trades. Filtros de descarte, en este orden:
top 10 (sin la curva) ≤ 20 %, wallets del primer bloque (2 s) ≤ 30 %, el dev
no ha vendido, volumen ≥ 5 SOL, ≥ 15 holders, no cerca de graduar. Entrada si
en los últimos 60 s: SOL neto comprado ≥ 2, compradores únicos ≥ 8, ratio
compras/ventas ≥ 2 y **score ≥ 0,6**. Score = 0,35·netBuy + 0,25·buyers +
0,2·ratio + 0,2·dispersión, cada componente recortado a [0, 1]: cumplir un
umbral justo vale 0,5, el doble vale 1; dispersión = 1 − top10/0,2.
Salidas: stop, trailing (activa a +12 %, cierra 8 pp bajo el máximo), toma de
ganancia 50 % a +30 %, el dev vende, flujo neto de 30 s ≤ −1 SOL, time stop
10 min. Sin promediar, sin re-entrar tras operar un token.

Cada decisión y cada operación guarda `strategy_version` y `config_hash`:
cambiar un número de la config es una versión nueva, no una edición.

## Qué se registra (`data/memecoin-lab.db`, gitignored)

`tokens` (todo token visto, agregados para siempre), `decisions` (UNA por
candidato: entrada, o descarte con motivo en su **mejor momento** = mayor
score, y a igual score el filtro más cercano a la entrada), `outcomes`
(desenlace de TODA decisión: precio a +5 min / +1 h / +24 h, rug = −90 %,
graduó), `orders` (fills, costes, latencia real, firma del trade de
referencia), `positions` (P&L, costes, gap del stop, hueco), `raw_trades`
(solo de tokens con decisión; retención 7 días, borrado horario,
`wal_checkpoint(TRUNCATE)` diario), `equity`, `gaps`, `meta`.

## Memoria y CPU acotadas por construcción

Todo mapa tiene tope y desalojo (`config.limits`): 2 000 tokens vigilados
(se desaloja el más antiguo), 5 000 wallets por token (al superarlo el token
queda marcado como no exacto), 3 000 trades y 1 000 muestras de precio por
token, 20 000 desenlaces pendientes, 100 000 firmas para deduplicar, cola de
5 000 frames (si se llena, descarta y cuenta como hueco). `soak.test.ts`
mete 200 000 eventos de 5 200 tokens y comprueba cada tope, además de 50
reconexiones con un único socket y ≤ 2 temporizadores. El heartbeat
(`data/memecoin-lab.heartbeat`, cada 30 s) es una línea JSON con `rss_mb`,
`heap_mb`, tokens, cola, eventos/s, GB/día y huecos; si `rss_mb` > 400 el
proceso sale con código 2 y systemd lo reinicia (`MemoryMax=512M`,
`CPUQuota=30%`, `Nice=10`).

## Cómo correrlo y leer el informe

```bash
bun labs/memecoin/main.ts --minutes 3        # prueba corta (sin --minutes: indefinido)
bun labs/memecoin/report.ts --hours 24       # informe en español
scripts/install-memecoin-lab.sh              # unidad systemd de usuario (idempotente)
bun test labs/memecoin                       # sin red, determinista, < 10 s
```

Informe: **SALDO** (caja, equity, curva, USD informativo), **OPERACIONES
CERRADAS** (n, win rate, P&L medio, peor/mejor, gap medio del stop, costes,
latencia), **EMBUDO** (tokens vistos → candidatos → entradas, descartes por
motivo), **APRENDIZAJE** (por cada motivo de descarte y para las entradas:
mediana del retorno de precio a +5 min/+1 h/+24 h, % rug, % graduó) y **QUÉ
CAMBIAR**: motivos cuyos descartados lo hicieron mejor a +1 h que las entradas
(«relajar») o peor («mantener»). Un resumen de 24 h va cada día al chat de OPS
de Telegram (`TELEGRAM_OPS_CHAT_ID`, `MEMECOIN_DAILY_HOUR_UTC`, por defecto 12);
si falla, solo log.
