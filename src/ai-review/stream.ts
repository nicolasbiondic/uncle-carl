// Reads the event stream of `opencode run --format json` (one JSON object per line): the final answer is the
// last text part; the tools that ran are recorded (was a web search made, which pages were opened) and every URL
// the run actually SAW (case file aside) is collected so a source a model invents can be told from one it opened.
// Enforced: src/ai-review/stream.test.ts.

export interface ToolCall { tool: string; status: string; url?: string; query?: string }
export interface StreamResult {
  sessionId: string | null;
  /** Last text part; null when the run produced none. */
  answer: string | null;
  tools: ToolCall[];
  /** A web search that completed (a cancelled or failed one does not count). */
  searched: boolean;
  fetchedUrls: string[];
  /** Every URL that appeared in a completed web tool's input or output. */
  seenUrls: string[];
  error: string | null;
  costUsd: number;
  tokens: number;
}

const URL_RE = /https?:\/\/[^\s)\]>"'<\\]+/g;

/** Same page, different spelling (fragment, trailing slash, host case, tracking noise). */
export function normalizeUrl(u: string): string {
  try {
    const x = new URL(u);
    x.hash = "";
    for (const k of [...x.searchParams.keys()]) if (/^(utm_|fbclid|gclid|ref$)/i.test(k)) x.searchParams.delete(k);
    return `${x.protocol}//${x.host.toLowerCase()}${x.pathname.replace(/\/+$/, "")}${x.search}`;
  } catch { return u; }
}

export function parseStream(text: string): StreamResult {
  const r: StreamResult = { sessionId: null, answer: null, tools: [], searched: false, fetchedUrls: [], seenUrls: [], error: null, costUsd: 0, tokens: 0 };
  const seen = new Set<string>();
  for (const line of text.split("\n")) {
    const s = line.trim();
    if (!s.startsWith("{")) continue;
    let e: any;
    try { e = JSON.parse(s); } catch { continue; }
    if (typeof e?.sessionID === "string") r.sessionId ??= e.sessionID;
    if (e.type === "text" && typeof e.part?.text === "string") r.answer = e.part.text;
    else if (e.type === "error") {
      const m = e.error?.message ?? e.error?.data?.message ?? e.message;
      r.error = String(m ?? "error event").slice(0, 300);
    } else if (e.type === "step_finish") {
      r.costUsd += Number(e.part?.cost) || 0;
      const t = e.part?.tokens;
      if (t) r.tokens += (Number(t.input) || 0) + (Number(t.output) || 0) + (Number(t.reasoning) || 0);
    } else if (e.type === "tool_use") {
      const tool = String(e.part?.tool ?? "?");
      const st = e.part?.state ?? {};
      const status = String(st.status ?? "?");
      const call: ToolCall = { tool, status };
      if (typeof st.input?.url === "string") call.url = st.input.url;
      if (typeof st.input?.query === "string") call.query = st.input.query;
      r.tools.push(call);
      if (status === "completed" && (tool === "websearch" || tool === "webfetch")) {
        if (tool === "websearch") r.searched = true;
        if (tool === "webfetch" && call.url) r.fetchedUrls.push(call.url);
        const hay = `${typeof st.output === "string" ? st.output : ""} ${call.url ?? ""}`;
        for (const u of hay.match(URL_RE) ?? []) seen.add(normalizeUrl(u.replace(/[.,;:]+$/, "")));
        if (call.url) seen.add(normalizeUrl(call.url));
      }
    }
  }
  r.seenUrls = [...seen];
  return r;
}
