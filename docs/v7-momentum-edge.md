# v8 Momentum TSM - Runbook de validacion

## Estado actual

`MomentumEngine` ejecuta time-series momentum en dos sleeves independientes:

- `momentum_stocks`: Alpaca, barras de 5 minutos, mercado regular.
- `momentum_crypto`: Binance Futures, barras de 1 hora y funding historico.

El unico replay valido es `scripts/backtest-momentum-wf.ts`. Los antiguos
`backtest-momentum.ts` y `optimize-momentum.ts` fueron eliminados: leian una
ventana corta de `price_history`, seleccionaban y evaluaban sobre los mismos
datos, y no reproducian margen, funding, stops ni fills de produccion.

Ningun backtest cambia configuracion live ni despliega automaticamente.

## Evidencia honesta

Replay corregido a 60 minutos, costos y riesgo de produccion:

| Sleeve | Periodo | Resultado |
|---|---|---|
| Stocks | 2024 | +62.4% |
| Stocks | 2025 | +21.4% |
| Stocks | 2026 YTD | +9.3% |
| Crypto | 2022 | -26.4% |
| Crypto | 2025 | -15.5% |
| Crypto | 2026 YTD | -17.7% |

Nested walk-forward incumbent-only, `asOf=2026-07-15`:

| Sleeve | Outer folds | Stitched OOS | Sharpe | Max DD | Veredicto |
|---|---|---|---|---|---|
| Stocks | -22.8%, +41.2%, -1.2% | +7.6% | 0.26 | 25.8% | Gates cuantitativos pasan; trial ledger incompleto |
| Crypto | artifact corregido abajo | +386.37% | 0.979 | 49.18% | Falla DD base 45%, stress 59.41% y LOO 63.55% |

Estos manifests contienen solo el incumbent: validan el protocolo y la
configuracion actual, pero no constituyen optimizacion ni autorizan cambios.

Por ventana anual, el drawdown llega aproximadamente a 19% en stocks y 48% en
crypto; el stitched OOS nested alcanza 25.8% y 49.18%, respectivamente.
La base operativa legacy confirma la divergencia: PnL atribuible de stocks
+$187.83 y crypto -$335.90. Por eso `momentum_crypto` genera nuevas entradas
en shadow; no se debe promocionar ni aumentar capital sin nueva evidencia OOS.

Los 251 trials historicos se cuentan para Deflated Sharpe y se registran en
`experiments/historical-hypothesis-ledger-v1.json`; el ledger sigue incompleto.
Los manifests lo declaran explicitamente con
`trialAccounting.complete=false`, de modo que no pueden aprobar un candidato.
El artefacto crypto corregido es
`data/backtests/aaed66e71db8184bfa7be6e3f1a9c698164f06fa02437b9a6939735b90b812bc/`
(base +386.37%, Sharpe .979, DD 49.18%, stress DD 59.41%, LOO DD 63.55%,
648 trades); permanece en shadow.

## Comandos canonicos

```bash
# Replay descriptivo, sin seleccion de parametros
bun run backtest:momentum-wf -- --sleeve stocks
bun run backtest:momentum-wf -- --sleeve crypto

# Validar manifests y snapshot sin ejecutar trials
bun run experiment:wf -- experiments/momentum-stocks-v1.json --dry-run
bun run experiment:wf -- experiments/momentum-crypto-v1.json --dry-run

# Ejecutar el protocolo completo
bun run experiment:wf -- experiments/momentum-stocks-v1.json
bun run experiment:wf -- experiments/momentum-crypto-v1.json
```

Los resultados se escriben en `data/backtests/<runHash>/`. `runHash` liga la
configuracion semantica, las filas exactas de datos consumidas, el codigo, el
lockfile y la version de Bun. Un cambio de datos o codigo crea otra carpeta.

## Protocolo

1. Crea un snapshot SQLite inmutable antes de resolver `asOf=latest`.
2. Reserva el primer segmento como entrenamiento y genera folds outer OOS.
3. Selecciona candidatos solo con los folds inner anteriores al purge gap.
4. Corrige DSR por candidates actuales y trials historicos declarados.
5. Ejecuta el ganador por fold con costos base y stress, sin reseleccion.
6. Une exclusivamente los folds outer y calcula concentracion y leave-one-out.
7. Falla cerrado ante datos, funding, trials o gates incompletos.
8. Aunque todos los gates pasen, espera aprobacion humana y nunca auto-deploya.

## Regla de cambios

No ajustar entry, exit, cadence, slots, leverage ni universos usando un replay
in-sample, una unica ventana ganadora o PnL live de pocos trades. Primero se
declaran candidatos en un nuevo manifest; luego se ejecuta nested walk-forward
y se conserva el output hasheado. La configuracion live solo cambia tras una
decision humana basada en ese artefacto y evidencia paper suficiente.
