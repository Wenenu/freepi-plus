import { describe, expect, test } from "bun:test";
import { extractTextToolCalls, looksLikeToolMarkup } from "../src/text-tool-parser";

describe("extractTextToolCalls", () => {
  test("parses direct <bash> tag", () => {
    const input = `Let me check the directory:\n<bash>\nls -la /root/workspace/\n</bash>\nDone.`;
    const res = extractTextToolCalls(input);
    expect(res.hasToolCalls).toBe(true);
    expect(res.toolCalls).toHaveLength(1);
    expect(res.toolCalls[0].name).toBe("bash");
    expect(res.toolCalls[0].arguments).toEqual({ command: "ls -la /root/workspace/" });
  });

  test("parses DeepSeek DSML format with cmd parameter", () => {
    const input = `
<｜DSML｜tools_call>
<｜DSML｜bash_tool>
<｜DSML｜parameter name="cmd">ls -la /root/workspace/bugbounty/ 2>/dev/null | head -50; echo "---"; ls /root/workspace/</｜DSML｜parameter>
</｜DSML｜invoke>
</｜DSML｜tool_call>
`;
    const res = extractTextToolCalls(input);
    expect(res.hasToolCalls).toBe(true);
    expect(res.toolCalls).toHaveLength(1);
    expect(res.toolCalls[0].name).toBe("bash");
    expect(res.toolCalls[0].arguments).toEqual({
      command: `ls -la /root/workspace/bugbounty/ 2>/dev/null | head -50; echo "---"; ls /root/workspace/`,
    });
  });

  test("parses standard <invoke name='bash'> with <parameter name='command'>", () => {
    const input = `
<invoke name="bash">
<parameter name="command">ls -la /root/workspace/</parameter>
</invoke>
`;
    const res = extractTextToolCalls(input);
    expect(res.hasToolCalls).toBe(true);
    expect(res.toolCalls).toHaveLength(1);
    expect(res.toolCalls[0].name).toBe("bash");
    expect(res.toolCalls[0].arguments).toEqual({ command: "ls -la /root/workspace/" });
  });

  test("parses multiple consecutive <bash> blocks", () => {
    const input = `
<bash>
ls -la /root/workspace/
</bash>

<bash>
find /root/workspace -name "*.md"
</bash>
`;
    const res = extractTextToolCalls(input);
    expect(res.hasToolCalls).toBe(true);
    expect(res.toolCalls).toHaveLength(2);
    expect(res.toolCalls[0].arguments).toEqual({ command: "ls -la /root/workspace/" });
    expect(res.toolCalls[1].arguments).toEqual({ command: 'find /root/workspace -name "*.md"' });
  });

  test("parses <tool_call> JSON format", () => {
    const input = `
<tool_call>
{"name": "read", "arguments": {"file": "README.md"}}
</tool_call>
`;
    const res = extractTextToolCalls(input);
    expect(res.hasToolCalls).toBe(true);
    expect(res.toolCalls).toHaveLength(1);
    expect(res.toolCalls[0].name).toBe("read");
    expect(res.toolCalls[0].arguments).toEqual({ path: "README.md" });
  });

  test("parses <bash_command cmd='...' /> and <bash_command cmd='...'>...</bash_command>", () => {
    const input = `
Let me explore:
<bash_command cmd="ls -la /root/workspace/ && cat /root/workspace/bugbounty/AGENTS.md" />
And then:
<bash_command cmd="cd /root/workspace/bugbounty && ls -la"></bash_command>
`;
    const res = extractTextToolCalls(input);
    expect(res.hasToolCalls).toBe(true);
    expect(res.toolCalls).toHaveLength(2);
    expect(res.toolCalls[0].name).toBe("bash");
    expect(res.toolCalls[0].arguments).toEqual({
      command: "ls -la /root/workspace/ && cat /root/workspace/bugbounty/AGENTS.md",
    });
    expect(res.toolCalls[1].name).toBe("bash");
    expect(res.toolCalls[1].arguments).toEqual({
      command: "cd /root/workspace/bugbounty && ls -la",
    });
  });

  test("does nothing for regular text without tool calls", () => {
    const input = "Here is an explanation of the code.";
    const res = extractTextToolCalls(input);
    expect(res.hasToolCalls).toBe(false);
    expect(res.toolCalls).toHaveLength(0);
    expect(res.cleanText).toBe(input);
  });
});

describe("extractTextToolCalls — the DSML shapes that used to stop the chat", () => {
  // Reported from a real session: the turn ended with the call still printed as
  // text, and the conversation stopped there. Two things broke the recovery —
  // the wrapper is spelled `tool_calls` (plural), and the parameter carries
  // `string="false"` plus a JSON body, so the argument never reached `command`.
  test("parses the `tool_calls` wrapper with an `arguments` parameter and extra attributes", () => {
    const command =
      `cd /tmp/kelp-lrt && which slither forge 2>/dev/null; echo "---"; forge --version 2>/dev/null; ` +
      `which solc 2>/dev/null; python3 -c "import slither; print('slither py ok')" 2>/dev/null; echo "done"`;
    const input = `
<｜DSML｜tool_calls>
 <｜DSML｜invoke name="bash">
 <｜DSML｜parameter name="arguments" string="false">${JSON.stringify({ command })}</｜DSML｜parameter>
 </｜DSML｜invoke>
 </｜DSML｜tool_calls>
`;
    const res = extractTextToolCalls(input);
    expect(res.toolCalls).toHaveLength(1);
    expect(res.toolCalls[0].name).toBe("bash");
    expect(res.toolCalls[0].arguments).toEqual({ command });
    // Nothing of the call is left on screen for the model to re-read as prose.
    expect(res.cleanText).toBe("");
  });

  test("parses a multi-line JSON body containing a heredoc", () => {
    const command = `cd /root/workspace/bugbounty && python3 - <<'EOF'\nimport os, json, urllib.request\nkey=os.environ.get("ALCHEMY_API_KEY","")\nurl=f"https://eth-mainnet.g.alchemy.com/v2/{key}"\nprint(url)\nEOF`;
    const input = `<｜DSML｜tool_calls>\n<｜DSML｜invoke name="bash">\n<｜DSML｜parameter name="arguments" string="false">${JSON.stringify({ command })}</｜DSML｜parameter>\n</｜DSML｜invoke>\n</｜DSML｜tool_calls>`;
    const res = extractTextToolCalls(input);
    expect(res.toolCalls).toHaveLength(1);
    expect(res.toolCalls[0].arguments).toEqual({ command });
  });

  test("accepts every wrapper spelling, with or without the invoke form", () => {
    for (const wrapper of ["tool_call", "tool_calls", "tools_call", "tools_calls"]) {
      const res = extractTextToolCalls(
        `<｜DSML｜${wrapper}>\n<｜DSML｜bash_tool>\n<｜DSML｜parameter name="cmd">ls -la</｜DSML｜parameter>\n</｜DSML｜invoke>\n</｜DSML｜${wrapper}>`,
      );
      expect(res.hasToolCalls).toBe(true);
      expect(res.toolCalls[0]?.arguments).toEqual({ command: "ls -la" });
    }
  });

  // The same call, with one escape broken — a raw newline inside the heredoc, as
  // the model really emitted it. The blob is no longer valid JSON, and the old
  // fallback handed the whole `{"command": …}` text to bash as the command.
  test("recovers the command from an argument blob whose escaping is broken", () => {
    const inner = `print(os.environ.get("ALCHEMY_API_KEY", ""))`;
    const command = `cd /root/workspace/bugbounty && python3 - <<'EOF'\nimport os\n${inner}\nEOF`;
    // The quotes are escaped, the newlines are not: that one broken escape is
    // exactly what makes JSON.parse throw. It used to hand bash the whole blob.
    const brokenBlob = `{"command": "cd /root/workspace/bugbounty && python3 - <<'EOF'\nimport os\n${inner.replace(/"/g, '\\"')}\nEOF"}`;
    expect(() => JSON.parse(brokenBlob)).toThrow();

    const res = extractTextToolCalls(
      `<｜DSML｜tool_calls>\n<｜DSML｜invoke name="bash">\n<｜DSML｜parameter name="arguments" string="false">${brokenBlob}</｜DSML｜parameter>\n</｜DSML｜invoke>\n</｜DSML｜tool_calls>`,
    );
    expect(res.toolCalls).toHaveLength(1);
    expect(res.toolCalls[0]?.arguments).toEqual({ command });
  });

  test("salvages a call whose argument string was cut off inside a complete block", () => {
    const res = extractTextToolCalls(
      `<｜DSML｜tool_calls>\n<｜DSML｜invoke name="bash">\n<｜DSML｜parameter name="arguments">{"command": "ls -la /root</｜DSML｜parameter>\n</｜DSML｜invoke>\n</｜DSML｜tool_calls>`,
    );
    expect(res.toolCalls).toHaveLength(1);
    expect(res.toolCalls[0]?.arguments).toEqual({ command: "ls -la /root" });
  });

  test("a call the model never closed is left alone — the nudge asks for it again", () => {
    // A markup block whose closing tags never arrived: the arguments are cut off
    // mid-command, and running a truncated shell command is worse than asking
    // for the call again. It must still be recognized as markup, because that is
    // what makes the session say "continue" instead of stopping.
    const text = `<｜DSML｜tool_calls>\n<｜DSML｜invoke name="bash">\n<｜DSML｜parameter name="arguments">{"command": "ls -la /root`;
    const res = extractTextToolCalls(text);
    expect(res.hasToolCalls).toBe(false);
    expect(looksLikeToolMarkup(text)).toBe(true);
  });

  test("unwraps a non-bash tool's argument blob into the argument that tool takes", () => {
    const res = extractTextToolCalls(
      `<｜DSML｜tool_calls>\n<｜DSML｜invoke name="read">\n<｜DSML｜parameter name="arguments">{"path": "/root/workspace/x.md", "limit": 40}</｜DSML｜parameter>\n</｜DSML｜invoke>\n</｜DSML｜tool_calls>`,
    );
    expect(res.toolCalls[0]?.name).toBe("read");
    expect(res.toolCalls[0]?.arguments).toMatchObject({ path: "/root/workspace/x.md" });
  });

  test("unwraps a plain `arguments` string that is not JSON into the primary argument", () => {
    const res = extractTextToolCalls(`<｜DSML｜tool_calls>
<｜DSML｜invoke name="bash">
<｜DSML｜parameter name="arguments">ls -la /root</｜DSML｜parameter>
</｜DSML｜invoke>
</｜DSML｜tool_calls>`);
    expect(res.toolCalls[0]?.arguments).toEqual({ command: "ls -la /root" });
  });
});

describe("looksLikeToolMarkup", () => {
  test("recognizes the markup a model leaves behind", () => {
    expect(looksLikeToolMarkup('<｜DSML｜tool_calls>\n<｜DSML｜invoke name="bash">')).toBe(true);
    expect(looksLikeToolMarkup('<tool_call>{"name":"bash"}</tool_call>')).toBe(true);
    expect(looksLikeToolMarkup('<invoke name="bash">')).toBe(true);
    expect(looksLikeToolMarkup('<function_calls>')).toBe(true);
  });

  test("stays quiet for ordinary prose and for mentions in backticks", () => {
    expect(looksLikeToolMarkup("All done: the tests pass and the build is clean.")).toBe(false);
    expect(looksLikeToolMarkup("I ran `npm test` and it passed.")).toBe(false);
    expect(looksLikeToolMarkup(undefined)).toBe(false);
    expect(looksLikeToolMarkup("")).toBe(false);
  });
});
