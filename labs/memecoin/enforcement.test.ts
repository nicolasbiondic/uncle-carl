/**
 * Reglas duras del laboratorio, con test que las hace cumplir:
 *   - CERO dinero real: ningún archivo de labs/memecoin/ contiene las
 *     palabras de firma/wallet (lista construida por concatenación para que
 *     este mismo archivo no se delate) ni importa las librerías @solana/*;
 *     package.json no añade dependencias @solana.
 *   - Aislamiento: del código del bot solo se importa src/utils/logger (y
 *     events, que el logger arrastra), nunca el motor de trading.
 *   - Regla del dueño: time stop ≤ 1 h y tope duro de 5 días en la config.
 *   - Unidad systemd con los límites pedidos; el instalador la renderiza.
 */
import { describe, expect, test } from "bun:test";
import { existsSync, readdirSync, readFileSync, statSync } from "fs";
import { join, relative } from "path";
import { LAB_CONFIG } from "./config";

const LAB_DIR = import.meta.dir;
const REPO_ROOT = join(LAB_DIR, "..", "..");

function walk(dir: string, out: string[]): void {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) walk(full, out);
    else out.push(full);
  }
}

const FORBIDDEN = ["Key" + "pair", "secret" + "Key", "send" + "Transaction", "sign" + "Transaction", "private" + "Key", "@solana/" + "web3.js", "@solana/" + "kit", "sign" + "AllTransactions", "bs58." + "decode"];

describe("memecoin lab — enforcement", () => {
  const files: string[] = [];
  walk(LAB_DIR, files);

  test("ningún archivo del lab menciona wallet/firma/envío de transacciones ni importa @solana/*", () => {
    const offenders: string[] = [];
    for (const file of files) {
      const text = readFileSync(file, "utf-8");
      for (const word of FORBIDDEN) if (text.includes(word)) offenders.push(`${relative(REPO_ROOT, file)}: ${word}`);
    }
    expect(offenders).toEqual([]);
  });

  test("package.json no trae dependencias @solana/*", () => {
    const pkg = JSON.parse(readFileSync(join(REPO_ROOT, "package.json"), "utf-8"));
    const deps = Object.keys({ ...pkg.dependencies, ...pkg.devDependencies });
    expect(deps.filter((d) => d.startsWith("@solana/"))).toEqual([]);
  });

  test("aislamiento: del bot solo se importa src/utils/logger", () => {
    const bad: string[] = [];
    for (const file of files.filter((f) => f.endsWith(".ts"))) {
      const text = readFileSync(file, "utf-8");
      for (const m of text.matchAll(/from\s+"([^"]+)"/g)) {
        const spec = m[1];
        if (spec.includes("/src/") || spec.startsWith("../")) {
          if (spec !== "../../src/utils/logger") bad.push(`${relative(REPO_ROOT, file)}: ${spec}`);
        }
      }
    }
    expect(bad).toEqual([]);
  });

  test("regla del dueño en la config: time stop ≤ 1 h, tope duro 5 días, nunca se pausa por pérdidas", () => {
    expect(LAB_CONFIG.strategy.exits.timeStopMs).toBeLessThanOrEqual(3_600_000);
    expect(LAB_CONFIG.strategy.exits.hardMaxHoldMs).toBe(5 * 86_400_000);
    // No existe ningún parámetro de pausa/apagado por drawdown: el riesgo se controla por tamaño.
    const keys = JSON.stringify(LAB_CONFIG).toLowerCase();
    for (const w of ["pause", "halt", "maxdrawdown", "dailyloss", "kill"]) expect(keys).not.toContain(w);
    expect(LAB_CONFIG.strategy.sizing.fractionOfBalance).toBeLessThanOrEqual(0.1);
    expect(LAB_CONFIG.account.initialSol).toBe(10);
  });

  test("costes del simulador declarados y conservadores", () => {
    expect(LAB_CONFIG.sim.pumpFeeBpsFloor).toBeGreaterThanOrEqual(125);
    expect(LAB_CONFIG.sim.mevPerSide).toBeGreaterThanOrEqual(0.01);
    expect(LAB_CONFIG.sim.txFeeSol).toBeGreaterThan(0);
    expect(LAB_CONFIG.sim.latencyMs).toBeGreaterThanOrEqual(1_000);
    expect(LAB_CONFIG.sim.migrationExitPenalty).toBeGreaterThanOrEqual(0.2);
  });

  test("unidad systemd e instalador: límites pedidos, sin instalar nada aquí", () => {
    const unit = readFileSync(join(REPO_ROOT, "scripts", "memecoin-lab.service"), "utf-8");
    for (const line of ["Restart=always", "RestartSec=10", "Nice=10", "MemoryMax=512M", "CPUQuota=30%", "ExecStart=__BUN__ labs/memecoin/main.ts", "WorkingDirectory=__ROOT__"]) expect(unit).toContain(line);
    const script = readFileSync(join(REPO_ROOT, "scripts", "install-memecoin-lab.sh"), "utf-8");
    expect(script).toContain("memecoin-lab.service");
    expect(script).toContain("daemon-reload");
    expect(script).toContain("set -euo pipefail");
    expect(script).toContain("__BUN__");
    expect(script).toContain("__ROOT__");
    // El RSS máximo del proceso queda por debajo del MemoryMax de la unidad.
    expect(LAB_CONFIG.limits.maxRssMb).toBeLessThan(512);
  });

  test("el heartbeat va donde lo vigila el loop de mejora (data/memecoin-lab.heartbeat, ≤ 60 s)", () => {
    const main = readFileSync(join(LAB_DIR, "main.ts"), "utf-8");
    expect(main).toContain('"memecoin-lab.heartbeat"');
    expect(LAB_CONFIG.feed.heartbeatIntervalMs).toBeLessThanOrEqual(60_000);
    // The improvement loop is instance-specific and not in the public export
    // (scripts/public-export/exclude.txt): check the pairing only where it exists.
    const loopPath = join(REPO_ROOT, "scripts", "improvement-loop.sh");
    if (existsSync(loopPath)) expect(readFileSync(loopPath, "utf-8")).toContain("data/memecoin-lab.heartbeat");
  });
});
