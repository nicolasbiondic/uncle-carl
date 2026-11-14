import { describe, expect, test } from "bun:test";
import { normalizeUrl, parseStream } from "./stream";

const ev = (o: unknown) => JSON.stringify(o);
const text = (t: string) => ev({ type: "text", sessionID: "ses_1", part: { type: "text", text: t } });
const tool = (name: string, status: string, input: object, output = "") => ev({ type: "tool_use", sessionID: "ses_1", part: { type: "tool", tool: name, state: { status, input, output } } });

describe("event stream", () => {
  test("the final answer is the LAST text part; the session id is kept", () => {
    const s = parseStream([ev({ type: "step_start", sessionID: "ses_1" }), text("pensando"), text('{"a":1}')].join("\n"));
    expect(s.answer).toBe('{"a":1}');
    expect(s.sessionId).toBe("ses_1");
  });
  test("a completed web search counts as searched; a cancelled one does not", () => {
    expect(parseStream(tool("websearch", "completed", { query: "x" }, "## [Reuters](https://reuters.com/a)")).searched).toBe(true);
    const cancelled = parseStream(tool("websearch", "error", { query: "x" }, "Cancelled a request for input this run cannot answer: Web Search"));
    expect(cancelled.searched).toBe(false);
    expect(cancelled.tools).toEqual([{ tool: "websearch", status: "error", query: "x" }]);
  });
  test("pages opened and every URL seen in a web tool's result are recorded", () => {
    const s = parseStream([
      tool("webfetch", "completed", { url: "https://cnbc.com/story/" }, "body with https://other.com/z, and more"),
      tool("websearch", "completed", { query: "q" }, "- [A](https://a.com/1)\n- [B](https://b.com/2)"),
      tool("read", "completed", { path: "/x/casefile.json" }, "https://not-a-web-tool.com/x"),
    ].join("\n"));
    expect(s.fetchedUrls).toEqual(["https://cnbc.com/story/"]);
    expect(s.seenUrls).toContain("https://cnbc.com/story");
    expect(s.seenUrls).toContain("https://other.com/z");
    expect(s.seenUrls).toContain("https://a.com/1");
    expect(s.seenUrls).toContain("https://b.com/2");
    expect(s.seenUrls).not.toContain("https://not-a-web-tool.com/x"); // the case file is not a page the model opened
  });
  test("an error event is surfaced; cost and tokens add up; junk lines are ignored", () => {
    const s = parseStream(["not json", ev({ type: "error", error: { message: "OpenCode Go requires an API key" } }), ev({ type: "step_finish", part: { cost: 0.01, tokens: { input: 10, output: 5, reasoning: 1 } } }), ev({ type: "step_finish", part: { cost: 0.02, tokens: { input: 1, output: 1 } } })].join("\n"));
    expect(s.error).toBe("OpenCode Go requires an API key");
    expect(s.answer).toBeNull();
    expect(s.costUsd).toBeCloseTo(0.03);
    expect(s.tokens).toBe(18);
  });
  test("URL normalisation ignores fragments, trailing slashes, host case and tracking noise", () => {
    expect(normalizeUrl("https://Reuters.com/a/b/?utm_source=x#top")).toBe(normalizeUrl("https://reuters.com/a/b"));
    expect(normalizeUrl("https://reuters.com/a?id=1")).not.toBe(normalizeUrl("https://reuters.com/a?id=2"));
  });
});
