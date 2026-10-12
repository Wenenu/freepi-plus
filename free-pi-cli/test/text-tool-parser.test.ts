import { describe, expect, test } from "bun:test";
import { extractTextToolCalls } from "../src/text-tool-parser";

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
