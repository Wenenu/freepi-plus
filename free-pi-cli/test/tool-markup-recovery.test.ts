// The session-level half of the DeepSeek DSML fix: a model that prints its tool
// call as text instead of making one used to leave the session holding a call it
// could not run — so the conversation simply stopped.
//
// Two mechanisms are asserted here, both driven through the shipped
// providerExtension (the same object buildRuntimeOptions gives the runtime, as
// in test/no-subagents.test.ts), with a fake pi surface:
//
//   * message_end recovers the call into a real ToolCall, so the turn continues;
//   * agent_end notices markup that could not be recovered and tells the model to
//     re-issue the call — bounded, so a model that will not comply cannot loop.
import { describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { InlineExtension } from "@earendil-works/pi-coding-agent";
import { buildRuntimeOptions, type LaunchOptions } from "../src/pi-launch";
import { PROVIDER_NAME } from "../src/provider";

const DSML_CALL = `<｜DSML｜tool_calls>
 <｜DSML｜invoke name="bash">
 <｜DSML｜parameter name="arguments" string="false">{"command":"ls -la /root/workspace"}</｜DSML｜parameter>
 </｜DSML｜invoke>
 </｜DSML｜tool_calls>`;

interface Harness {
  on: Map<string, (event: unknown, ctx: unknown) => unknown>;
  sent: Array<{ text: string; deliverAs?: string }>;
  ctx: { model: { provider: string } };
}

/** The shipped provider extension, wired to a fake pi that records what it hears. */
function harness(): Harness {
  const on = new Map<string, (event: unknown, ctx: unknown) => unknown>();
  const sent: Array<{ text: string; deliverAs?: string }> = [];
  const pi = {
    registerProvider: () => {},
    on: (name: string, handler: (event: unknown, ctx: unknown) => unknown) => on.set(name, handler),
    sendUserMessage: (text: string, options?: { deliverAs?: string }) => sent.push({ text, deliverAs: options?.deliverAs }),
  };
  const opts: LaunchOptions = {
    baseUrl: "http://example.test",
    jwt: "test-jwt",
    agentDir: mkdtempSync(join(tmpdir(), "free-pi-agentdir-")),
  };
  const runtime = buildRuntimeOptions(opts, "session-a");
  const extension = runtime.resourceLoaderOptions.extensionFactories.find(
    (candidate) => (typeof candidate === "function" ? "" : candidate.name) === "free-pi-provider",
  ) as InlineExtension & { name: string };
  const factory = (typeof extension === "function" ? extension : extension.factory) as (pi: unknown) => void;
  factory(pi);
  return { on, sent, ctx: { model: { provider: PROVIDER_NAME } } };
}

function assistantMessage(content: Array<Record<string, unknown>>, stopReason = "stop") {
  return { role: "assistant", provider: PROVIDER_NAME, stopReason, content };
}

describe("a tool call printed as text is executed, not printed", () => {
  test("message_end turns the text into a real call and the turn continues", async () => {
    const h = harness();
    const handler = h.on.get("message_end");
    expect(handler).toBeDefined();

    const result = (await handler?.({ message: assistantMessage([{ type: "text", text: `Let me look.\n${DSML_CALL}` }]) }, h.ctx)) as {
      message: { stopReason: string; content: Array<Record<string, unknown>> };
    };

    expect(result?.message.stopReason).toBe("toolUse");
    const calls = result.message.content.filter((block) => block.type === "toolCall") as Array<{ name: string; arguments: Record<string, unknown> }>;
    expect(calls).toHaveLength(1);
    expect(calls[0]?.name).toBe("bash");
    expect(calls[0]?.arguments).toEqual({ command: "ls -la /root/workspace" });
    // The prose the model wrote is kept; only the markup is consumed.
    expect(result.message.content.some((block) => block.type === "text" && String(block.text).includes("Let me look."))).toBe(true);
  });

  test("markup the parser cannot recover is reported to the model, at most twice", () => {
    const h = harness();
    const handler = h.on.get("agent_end");
    expect(handler).toBeDefined();
    // A wrapper with no invocation the parser can read: the call is lost, and
    // without the nudge this is where the session used to stop.
    const event = { messages: [assistantMessage([{ type: "text", text: "<｜DSML｜tool_calls>\n<｜DSML｜" }])] };

    handler?.(event, h.ctx);
    expect(h.sent).toHaveLength(1);
    expect(h.sent[0]?.text).toContain("Re-issue it as a real tool call");
    expect(h.sent[0]?.deliverAs).toBe("followUp");

    handler?.(event, h.ctx);
    expect(h.sent).toHaveLength(2);

    // Bounded: a model that keeps printing markup is left alone rather than
    // nudged forever.
    handler?.(event, h.ctx);
    expect(h.sent).toHaveLength(2);
  });

  test("an ordinary finished turn is not nudged, and a truncated one still is", () => {
    const h = harness();
    const handler = h.on.get("agent_end");
    handler?.({ messages: [assistantMessage([{ type: "text", text: "All done — the tests pass." }])] }, h.ctx);
    expect(h.sent).toHaveLength(0);

    handler?.({ messages: [assistantMessage([{ type: "text", text: "Working…" }], "length")] }, h.ctx);
    expect(h.sent).toHaveLength(1);
    expect(h.sent[0]?.text).toContain("got interrupted");
  });
});
