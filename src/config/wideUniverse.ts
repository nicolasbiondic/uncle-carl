// ══════════════════════════════════════════════
// Wide stock universe (~229 liquid US large-caps + sector ETFs)
// ══════════════════════════════════════════════
//
// Moved here from scripts/download-stock-dailies.ts (which re-exports it)
// so src/ code can import it — tsconfig rootDir is ./src.
//
// Used by:
//   - scripts/download-stock-dailies.ts (historical daily-bar downloader)
//   - scripts/backtest-meanrev-wide.ts (walk-forward, 4/6 positive windows)
// (the shadow_meanrev_wide sleeve that also consumed this in src/index.ts
// was removed 2026-09-25 — owner decision, no edge, dead by design)

import { MOMENTUM_STOCKS_UNIVERSE } from "./riskProfiles";

// S&P 100 constituents + next ~100 liquid S&P names + sector ETFs.
export const WIDE_UNIVERSE = [
  // S&P 100-ish
  "AAPL","ABBV","ABT","ACN","ADBE","AIG","AMD","AMGN","AMT","AMZN","AVGO","AXP",
  "BA","BAC","BK","BKNG","BLK","BMY","BRK.B","C","CAT","CHTR","CL","CMCSA","COF",
  "COP","COST","CRM","CSCO","CVS","CVX","DE","DHR","DIS","DUK","EMR","F",
  "FDX","GD","GE","GILD","GM","GOOG","GOOGL","GS","HD","HON","IBM","INTC","INTU",
  "ISRG","JNJ","JPM","KO","LIN","LLY","LMT","LOW","MA","MCD","MDLZ","MDT","MET",
  "META","MMM","MO","MRK","MS","MSFT","NEE","NFLX","NKE","NVDA","ORCL","PEP",
  "PFE","PG","PM","PYPL","QCOM","RTX","SBUX","SCHW","SO","SPG","T","TGT","TMO",
  "TMUS","TSLA","TXN","UNH","UNP","UPS","USB","V","VZ","WFC","WMT","XOM",
  // next ~100 liquid S&P names
  "A","AEP","AFL","ALL","AMAT","ADI","ADP","ADSK","APD","APH","AZO","BDX","BIIB",
  "BSX","CB","CCI","CDNS","CI","CMG","CME","CNC","CSX","CTAS","D","DAL","DG",
  "DHI","DLR","DOW","DXCM","EA","ECL","EL","EOG","EQIX","ETN","EW","EXC","FCX",
  "FI","FTNT","GEHC","GIS","HCA","HES","HLT","HPQ","HUM","ICE","IDXX","ITW",
  "KDP","KHC","KLAC","KMB","KMI","KR","LEN","LRCX","LULU","LUV","LVS","MAR",
  "MCHP","MCK","MCO","MELI","MNST","MPC","MRVL","MSI","MU","NOC","NOW","NSC",
  "NUE","NXPI","ODFL","OKE","ON","ORLY","OXY","PANW","PAYX","PCAR","PEG","PGR",
  "PH","PLD","PNC","PSA","PSX","PXD","REGN","ROP","ROST","SHW","SLB","SNPS",
  "STZ","SYK","SYY","TDG","TFC","TJX","TRV","TT","TTD","UAL","URI","VLO","VRTX",
  "WBA","WDC","WELL","WM","WMB","YUM","ZTS",
  // ETFs
  "SPY","QQQ","IWM","GLD","SLV","XLE","XLF","XLI","XLK","XLP","XLU","XLV","XLY",
  "XLB","XLRE","XLC","DIA","EFA","EEM","TLT","HYG",
];

// Was a hand-written duplicate of MOMENTUM_STOCKS_UNIVERSE that drifted
// (missed the +SMH addition in b5fb1e5) — single-sourced to make drift
// structurally impossible. See riskProfiles.disjoint.test.ts.
export const MOMENTUM_SYMBOLS = new Set(MOMENTUM_STOCKS_UNIVERSE);
