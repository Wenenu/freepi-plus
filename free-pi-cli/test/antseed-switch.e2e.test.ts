// End-to-end: the user's original bug. `/antseed model <peerId>@<model>` in a
// REAL AgentSession built from buildRuntimeOptions()'s production wiring must
// leave the session actually talking to the Antseed buyer proxy — not merely
// print a success notice while the next turn goes back to free-pi.
//
// Two stubs stand in for the two providers: free-pi's upstream and the local
// buyer proxy (pointed at by ANTSEED_BASE_URL). The switch is driven through the
// extension runner exactly as pi's TUI drives `/antseed`, and the assertion is
// on the next completion's destination and the model id it carries.
import { describe, expect, test } from "bun:test";
import type { ExtensionUIContext } from "@earendil-works/pi-coding-agent";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createAgentSessionFromServices,
  createAgentSessionServices,
  SessionManager,
} from "@earendil-works/pi-coding-agent";
import { buildRuntimeOptions, type LaunchOptions } from "../src/pi-launch";

const PEER_MODEL = "0b0b9574d5b038f6fd906325e699020423adf446@gpt-6.1-sol";

function tempDir(prefix: string): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

/** One assistant message, OpenAI-completions streaming shape. */
function textSse(text: string): string {
  const chunk = (delta: unknown, finish: string | null) =>
    `data: ${JSON.stringify({
      id: "resp-e2e",
      object: "chat.completion.chunk",
      created: 1,
      model: "e2e",
      choices: [{ index: 0, delta, finish_reason: finish }],
    })}\n\n`;
  return (
    chunk({ role: "assistant", content: text }, null) +
    chunk({}, "stop") +
    "data: [DONE]\n\n"
  );
}

describe("e2e: /antseed model <peer@model> routes the next turn to Antseed", () => {
  test("a real AgentSession switches provider and stays there", async () => {
    const freePiHits: string[] = [];
    const antseedHits: Array<{ model?: string; path: string }> = [];

    const freePi = Bun.serve({
      port: 0,
      async fetch(req) {
        const url = new URL(req.url);
        freePiHits.push(url.pathname);
        return new Response(textSse("free-pi answered"), {
          headers: { "content-type": "text/event-stream" },
        });
      },
    });
    const antseedProxy = Bun.serve({
      port: 0,
      async fetch(req) {
        const url = new URL(req.url);
        let model: string | undefined;
        try {
          model = ((await req.json()) as { model?: string }).model;
        } catch {
          model = undefined;
        }
        antseedHits.push({ model, path: url.pathname });
        return new Response(textSse("hello from antseed"), {
          headers: { "content-type": "text/event-stream" },
        });
      },
    });

    const previousBaseUrl = process.env.ANTSEED_BASE_URL;
    const previousCli = process.env.ANTSEED_CLI_COMMAND;
    // The buyer proxy lives at the stub; the balance CLI is absent, so the
    // footer must degrade to "unavailable" without spawning npx.
    process.env.ANTSEED_BASE_URL = antseedProxy.url.toString().replace(/\/$/, "");
    process.env.ANTSEED_CLI_COMMAND = "definitely-not-a-real-antseed-cli";

    const session = await (async () => {
      const cwd = tempDir("free-pi-cwd-");
      const opts: LaunchOptions = {
        baseUrl: freePi.url.toString().replace(/\/$/, ""),
        jwt: "test-jwt",
        agentDir: tempDir("free-pi-agentdir-"),
      };
      const { settingsManager, resourceLoaderOptions, tools } = buildRuntimeOptions(opts, "session-antseed-e2e");
      const services = await createAgentSessionServices({
        cwd,
        agentDir: opts.agentDir,
        settingsManager,
        resourceLoaderOptions,
      });
      return (
        await createAgentSessionFromServices({
          services,
          sessionManager: SessionManager.inMemory(cwd),
          tools: [...tools],
        })
      ).session;
    })();

    try {
      const runner = session.extensionRunner;
      const statuses: Array<[string, string | undefined]> = [];
      const notifications: string[] = [];
      runner.setUIContext(
        {
          notify: (message: string) => notifications.push(message),
          setStatus: (key: string, text: string | undefined) => statuses.push([key, text]),
        } as unknown as ExtensionUIContext,
        "tui",
      );

      const command = runner.getCommand("antseed");
      expect(command).toBeDefined();
      await command!.handler(`model ${PEER_MODEL}`, runner.createCommandContext());

      // 1. The session itself moved — the thing that silently failed before.
      expect(session.model?.provider).toBe("antseed");
      expect(session.model?.id).toBe(PEER_MODEL);
      expect(notifications.some((n) => n.includes("Switched") && n.includes(PEER_MODEL))).toBe(true);
      expect(notifications.some((n) => n.includes("Couldn't switch"))).toBe(false);

      // 2. The footer shows which antseed model is live.
      const antseedStatus = statuses.filter(([key]) => key === "antseed").map(([, text]) => text);
      expect(antseedStatus.some((text) => text?.startsWith("[Antseed]"))).toBe(true);
      expect(antseedStatus.some((text) => text?.includes("gpt-6.1-sol"))).toBe(true);

      // 3. A real turn lands on the buyer proxy, carrying the peer's model id.
      await session.prompt("Hello");
      expect(antseedHits.length).toBeGreaterThan(0);
      expect(antseedHits[0]!.path).toBe("/v1/chat/completions");
      expect(antseedHits[0]!.model).toBe(PEER_MODEL);
      // Only account/lease metadata may still touch free-pi (e.g. GET /me) —
      // not a single completion.
      expect(freePiHits.filter((path) => path.includes("chat/completions"))).toHaveLength(0);

      const lastAssistant = [...session.messages].reverse().find((m) => m.role === "assistant");
      expect(JSON.stringify(lastAssistant)).toContain("hello from antseed");
      expect(JSON.stringify(lastAssistant)).not.toContain("free-pi answered");
    } finally {
      session.dispose();
      freePi.stop(true);
      antseedProxy.stop(true);
      if (previousBaseUrl === undefined) delete process.env.ANTSEED_BASE_URL;
      else process.env.ANTSEED_BASE_URL = previousBaseUrl;
      if (previousCli === undefined) delete process.env.ANTSEED_CLI_COMMAND;
      else process.env.ANTSEED_CLI_COMMAND = previousCli;
    }
  }, 30_000);
});
