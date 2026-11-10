/**
 * Envío saliente a Telegram, mismo mecanismo que el bot
 * (`src/telegram/telegram-reporter.ts`: POST sendMessage, parse_mode HTML) y
 * misma política: solo el chat de OPS (`TELEGRAM_OPS_CHAT_ID`), sin
 * fallback al chat del usuario; si falta la variable o el envío falla, solo
 * se registra en el log. Lee `.env` de la raíz del repo con dotenv (ya es
 * dependencia), sin importar la configuración del bot.
 */
import { config as loadDotenv } from "dotenv";
import { join } from "path";

let loaded = false;
export function loadEnv(): void {
  if (loaded) return;
  loaded = true;
  loadDotenv({ path: join(import.meta.dir, "..", "..", ".env") });
}

export interface TelegramTarget {
  token: string;
  chatId: string;
}

export function opsTarget(env: Record<string, string | undefined> = process.env): TelegramTarget | null {
  const token = env.TELEGRAM_BOT_TOKEN ?? "";
  const chatId = env.TELEGRAM_OPS_CHAT_ID ?? "";
  if (!token || token === "your_telegram_bot_token" || !chatId) return null;
  return { token, chatId };
}

/** Telegram limita a 4096 caracteres por mensaje. */
export function chunkMessage(text: string, max = 3_900): string[] {
  const out: string[] = [];
  let rest = text;
  while (rest.length > max) {
    let cut = rest.lastIndexOf("\n", max);
    if (cut < max / 2) cut = max;
    out.push(rest.slice(0, cut));
    rest = rest.slice(cut);
  }
  out.push(rest);
  return out;
}

export async function sendOps(text: string, log: { warn(m: string): void }, fetchImpl: typeof fetch = fetch, target: TelegramTarget | null = opsTarget()): Promise<boolean> {
  if (!target) {
    log.warn("resumen Telegram no enviado: TELEGRAM_BOT_TOKEN/TELEGRAM_OPS_CHAT_ID sin configurar");
    return false;
  }
  let ok = true;
  for (const part of chunkMessage(text)) {
    try {
      const res = await fetchImpl(`https://api.telegram.org/bot${target.token}/sendMessage`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ chat_id: target.chatId, text: `<pre>${escapeHtml(part)}</pre>`, parse_mode: "HTML", disable_web_page_preview: true }),
        signal: AbortSignal.timeout(15_000),
      });
      const data: any = await res.json().catch(() => null);
      if (!data || data.ok !== true) {
        ok = false;
        log.warn(`Telegram sendMessage no confirmado (HTTP ${res.status})`);
      }
    } catch (e) {
      ok = false;
      log.warn(`Telegram sendMessage falló: ${String((e as Error)?.message ?? e)}`);
    }
  }
  return ok;
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}
