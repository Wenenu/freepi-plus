export interface ParsedToolCall {
  type: "toolCall";
  id: string;
  name: string;
  arguments: Record<string, any>;
}

export interface ParseResult {
  hasToolCalls: boolean;
  cleanText: string;
  toolCalls: ParsedToolCall[];
}

function generateToolCallId(): string {
  return `call_${Math.random().toString(36).slice(2, 10)}${Date.now().toString(36).slice(-4)}`;
}

function normalizeToolName(rawName: string): string {
  let name = rawName.trim().toLowerCase();
  if (name.endsWith("_tool")) {
    name = name.slice(0, -5);
  }
  if (name.startsWith("call:")) {
    name = name.slice(5);
  }
  return name;
}

function normalizeArguments(toolName: string, rawArgs: Record<string, any>): Record<string, any> {
  const args = { ...rawArgs };

  if (toolName === "bash") {
    if (!args.command) {
      if (typeof args.cmd === "string") args.command = args.cmd;
      else if (typeof args.code === "string") args.command = args.code;
      else if (typeof args.script === "string") args.command = args.script;
    }
    delete args.cmd;
    delete args.code;
    delete args.script;
  } else if (toolName === "read" || toolName === "ls") {
    if (!args.path) {
      if (typeof args.file === "string") args.path = args.file;
      else if (typeof args.filename === "string") args.path = args.filename;
      else if (typeof args.filepath === "string") args.path = args.filepath;
      else if (typeof args.dir === "string") args.path = args.dir;
      else if (typeof args.directory === "string") args.path = args.directory;
    }
    delete args.file;
    delete args.filename;
    delete args.filepath;
    delete args.dir;
    delete args.directory;
  } else if (toolName === "write" || toolName === "edit") {
    if (!args.path) {
      if (typeof args.file === "string") args.path = args.file;
      else if (typeof args.filename === "string") args.path = args.filename;
      else if (typeof args.filepath === "string") args.path = args.filepath;
    }
    delete args.file;
    delete args.filename;
    delete args.filepath;
  } else if (toolName === "grep" || toolName === "find") {
    if (!args.pattern && typeof args.query === "string") {
      args.pattern = args.query;
      delete args.query;
    }
    if (!args.path && typeof args.dir === "string") {
      args.path = args.dir;
      delete args.dir;
    }
  }

  // Some models put the whole native argument object inside a parameter named
  // `arguments` and leave it there: a bash call then arrives as
  // `{ arguments: { command: "…" } }`. Unwrap it before the primary-argument
  // fallback, or the tool is called with an argument it does not have.
  const wrappers = ["arguments", "input", "args", "parameters", "params", "tool_input"];
  const keys = Object.keys(args);
  if (keys.length === 1 && wrappers.includes((keys[0] as string).toLowerCase()) && typeof args[keys[0] as string] === "string") {
    const raw = args[keys[0] as string] as string;
    if (toolName === "bash" && !args.command) args.command = raw;
    else if ((toolName === "read" || toolName === "write" || toolName === "edit" || toolName === "ls") && !args.path) args.path = raw;
    else if ((toolName === "grep" || toolName === "find") && !args.pattern) args.pattern = raw;
    if (args.command || args.path || args.pattern) delete args[keys[0] as string];
  }

  return args;
}

/**
 * Names a model uses for the *container* of a tool call's real arguments — the
 * OpenAI-shaped `arguments` JSON blob, which is not a parameter of the tool.
 */
const ARGUMENT_WRAPPERS = new Set(["arguments", "input", "args", "parameters", "params", "tool_input", "function"]);

/** Parse `name="bash" string="false"` style attributes out of a tag's raw text. */
function parseTagAttributes(raw: string): Record<string, string> {
  const attrs: Record<string, string> = {};
  const attrRe = /([a-zA-Z0-9_:-]+)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+))/g;
  let match: RegExpExecArray | null;
  while ((match = attrRe.exec(raw)) !== null) {
    const key = match[1];
    if (!key) continue;
    attrs[key] = match[2] ?? match[3] ?? match[4] ?? "";
  }
  return attrs;
}

/**
 * A parameter tag whose value is a JSON object is the call's argument list, not
 * an argument called "arguments": unwrap it (repeatedly, for double-wrapped
 * models) and merge it with anything named explicitly alongside it.
 */
function mergeArgumentWrappers(args: Record<string, any>): Record<string, any> {
  let out = { ...args };
  for (let depth = 0; depth < 3; depth++) {
    const wrapper = Object.keys(out).find((key) => ARGUMENT_WRAPPERS.has(key.toLowerCase()));
    if (!wrapper) break;
    const value = out[wrapper];
    let parsed: any = value;
    if (typeof value === "string") {
      try {
        parsed = JSON.parse(value);
      } catch {
        break; // a plain string (e.g. a bare command) is handled by normalizeArguments
      }
    }
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) break;
    const explicit: Record<string, any> = {};
    for (const [key, val] of Object.entries(out)) {
      if (key !== wrapper) explicit[key] = val;
    }
    out = { ...(parsed as Record<string, any>), ...explicit };
    delete out[wrapper];
  }
  return out;
}

/**
 * The parameters of one DSML tool block: `<｜DSML｜parameter name="…" …>value
 * </｜DSML｜parameter>`, plus the self-closing `value="…"` form. Attributes other
 * than `name` are tolerated — DeepSeek emits `string="false"` on them, and a
 * regex that insists on `name="x">` silently reads the JSON body as the command.
 */
function parseDsmlParameters(body: string): { args: Record<string, any>; hasParams: boolean } {
  const args: Record<string, any> = {};
  let hasParams = false;
  const paired = /<[|｜]DSML[|｜]parameter\b([^>]*?)>([\s\S]*?)<\/[|｜]DSML[|｜]parameter>/gi;
  let match: RegExpExecArray | null;
  while ((match = paired.exec(body)) !== null) {
    const name = parseTagAttributes(match[1] ?? "").name;
    if (!name) continue;
    hasParams = true;
    args[name] = (match[2] ?? "").trim();
  }
  const selfClosing = /<[|｜]DSML[|｜]parameter\b([^>]*?)\/>/gi;
  while ((match = selfClosing.exec(body)) !== null) {
    const attrs = parseTagAttributes(match[1] ?? "");
    if (!attrs.name || attrs.name in args) continue;
    hasParams = true;
    args[attrs.name] = attrs.value ?? "";
  }
  return { args: mergeArgumentWrappers(args), hasParams };
}

/**
 * Extracts and parses tool calls emitted as text tokens by models (e.g. DeepSeek DSML,
 * XML invoke tags, or direct `<bash>` blocks) into structured pi ToolCall items.
 */
export function extractTextToolCalls(text: string): ParseResult {
  const toolCalls: ParsedToolCall[] = [];
  let cleanText = text;

  // 1. DeepSeek DSML format:
  // <｜DSML｜tools_call>
  // <｜DSML｜bash_tool> or <｜DSML｜call:bash> or <｜DSML｜invoke name="bash">
  // <｜DSML｜parameter name="...">...</｜DSML｜parameter>
  // ...
  // </｜DSML｜invoke> / </｜DSML｜call:...> / </｜DSML｜tool_call>
  // The wrapper is spelled `tool_call`, `tool_calls` (the shape DeepSeek emits),
  // `tools_call` and `tools_calls` in the wild — matching only the first two
  // meant the whole block fell through to the loose pass, or to nothing at all.
  const dsmlBlockRegex = /<[|｜]DSML[|｜]tools?_calls?>([\s\S]*?)<\/[|｜]DSML[|｜]tools?_calls?>/gi;
  cleanText = cleanText.replace(dsmlBlockRegex, (_, blockContent) => {
    // Find each tool invocation inside the DSML block
    // Can be <｜DSML｜bash_tool> ... </｜DSML｜...>, or <｜DSML｜invoke name="...">
    const toolRegex = /<[|｜]DSML[|｜](?:call:\s*([a-zA-Z0-9_-]+)|invoke\s+name=["']?([^"'>\s]+)["']?|([a-zA-Z0-9_-]+)_tool)>([\s\S]*?)(?:<\/[|｜]DSML[|｜](?:invoke|call:[^>]+|_tool|tools?_calls?)>|$)/gi;
    let match: RegExpExecArray | null;
    while ((match = toolRegex.exec(blockContent)) !== null) {
      const rawTool = match[1] || match[2] || match[3] || "bash";
      const body = match[4] || "";
      const { args: rawArgs, hasParams } = parseDsmlParameters(body);

      if (!hasParams) {
        // If no explicit parameter tags, treat body as primary argument (e.g. command for bash)
        const trimmedBody = body.replace(/<[^>]+>/g, "").trim();
        if (trimmedBody) {
          rawArgs["command"] = trimmedBody;
        }
      }

      const toolName = normalizeToolName(rawTool);
      toolCalls.push({
        type: "toolCall",
        id: generateToolCallId(),
        name: toolName,
        arguments: normalizeArguments(toolName, rawArgs),
      });
    }
    return "";
  });

  // Also catch unclosed / partial DSML tags if present
  const dsmlLooseRegex = /<[|｜]DSML[|｜](?:call:\s*([a-zA-Z0-9_-]+)|invoke\s+name=["']?([^"'>\s]+)["']?|([a-zA-Z0-9_-]+)_tool)>([\s\S]*?)<\/[|｜]DSML[|｜](?:invoke|call:[^>]+|_tool|tools?_calls?)>/gi;
  cleanText = cleanText.replace(dsmlLooseRegex, (_, m1, m2, m3, body) => {
    const rawTool = m1 || m2 || m3 || "bash";
    const { args: rawArgs, hasParams } = parseDsmlParameters(body);
    if (!hasParams) {
      const trimmed = body.replace(/<[^>]+>/g, "").trim();
      if (trimmed) rawArgs["command"] = trimmed;
    }
    const toolName = normalizeToolName(rawTool);
    toolCalls.push({
      type: "toolCall",
      id: generateToolCallId(),
      name: toolName,
      arguments: normalizeArguments(toolName, rawArgs),
    });
    return "";
  });

  // 2. Standard XML <invoke name="..."> / <call name="..."> blocks
  const invokeRegex =
    /<(?:invoke|call)\s+name=["']?([^"'>\s]+)["']?(?:\s[^>]*)?>([\s\S]*?)<\/(?:invoke|call)>/gi;
  cleanText = cleanText.replace(invokeRegex, (_, rawTool, body) => {
    const rawArgs: Record<string, any> = {};
    // Extra attributes (`string="false"`) are ignored rather than defeating the
    // match, and the same `arguments` wrapper is unwrapped here as in DSML.
    const paramRegex = /<parameter\b([^>]*?)>([\s\S]*?)<\/parameter>/gi;
    let pMatch: RegExpExecArray | null;
    let hasParams = false;
    while ((pMatch = paramRegex.exec(body)) !== null) {
      const name = parseTagAttributes(pMatch[1] ?? "").name;
      if (!name) continue;
      hasParams = true;
      rawArgs[name] = (pMatch[2] ?? "").trim();
    }
    if (!hasParams) {
      const trimmed = body.replace(/<[^>]+>/g, "").trim();
      if (trimmed) rawArgs["command"] = trimmed;
    }
    const toolName = normalizeToolName(rawTool);
    toolCalls.push({
      type: "toolCall",
      id: generateToolCallId(),
      name: toolName,
      arguments: normalizeArguments(toolName, mergeArgumentWrappers(rawArgs)),
    });
    return "";
  });

  // 3. JSON inside <tool_call> or <function_call>
  const jsonToolRegex = /<(?:tool_call|function_call)>([\s\S]*?)<\/(?:tool_call|function_call)>/gi;
  cleanText = cleanText.replace(jsonToolRegex, (_, jsonText) => {
    try {
      const parsed = JSON.parse(jsonText.trim());
      const rawTool = parsed.name || parsed.tool || "bash";
      const rawArgs = parsed.arguments || parsed.parameters || parsed.params || parsed.args || {};
      const toolName = normalizeToolName(rawTool);
      toolCalls.push({
        type: "toolCall",
        id: generateToolCallId(),
        name: toolName,
        arguments: normalizeArguments(toolName, rawArgs),
      });
      return "";
    } catch {
      return _;
    }
  });

  // 4. Self-closing tool calls: <bash_command cmd="..." /> or <bash cmd="..." />
  const selfClosingRegex = /<(bash(?:_command)?|read|edit|write|grep|find|ls)\s+([^>]*?)\s*\/>/gi;
  cleanText = cleanText.replace(selfClosingRegex, (_, rawTagName, attrString) => {
    const toolName = normalizeToolName(rawTagName.replace(/_command$/i, ""));
    const rawArgs: Record<string, any> = {};

    const attrRegex = /([a-zA-Z0-9_-]+)=["']([^"']*)["']/g;
    let aMatch: RegExpExecArray | null;
    let hasAttrs = false;
    while ((aMatch = attrRegex.exec(attrString)) !== null) {
      hasAttrs = true;
      rawArgs[aMatch[1]] = aMatch[2];
    }

    if (hasAttrs) {
      toolCalls.push({
        type: "toolCall",
        id: generateToolCallId(),
        name: toolName,
        arguments: normalizeArguments(toolName, rawArgs),
      });
      return "";
    }
    return _;
  });

  // 5. Direct or paired <bash>...</bash>, <bash_command>...</bash_command>
  const directTagRegex = /<(bash(?:_command)?|read|edit|write|grep|find|ls)(\s+[^>]*)?>([\s\S]*?)<\/\1>/gi;
  cleanText = cleanText.replace(directTagRegex, (_, tagName, attrString, content) => {
    const toolName = normalizeToolName(tagName.replace(/_command$/i, ""));
    const rawArgs: Record<string, any> = {};
    const trimmed = content.trim();

    if (attrString) {
      const attrRegex = /([a-zA-Z0-9_-]+)=["']([^"']*)["']/g;
      let aMatch: RegExpExecArray | null;
      while ((aMatch = attrRegex.exec(attrString)) !== null) {
        rawArgs[aMatch[1]] = aMatch[2];
      }
    }

    if (toolName === "bash") {
      if (!rawArgs["command"] && !rawArgs["cmd"]) {
        rawArgs["command"] = trimmed;
      }
    } else if (toolName === "read" || toolName === "ls") {
      if (!rawArgs["path"]) rawArgs["path"] = trimmed;
    } else if (toolName === "grep" || toolName === "find") {
      const parts = trimmed.split(/\s+/);
      if (parts.length > 1) {
        rawArgs["pattern"] = parts[0];
        rawArgs["path"] = parts.slice(1).join(" ");
      } else {
        rawArgs["pattern"] = trimmed;
      }
    } else {
      rawArgs["command"] = trimmed;
    }

    toolCalls.push({
      type: "toolCall",
      id: generateToolCallId(),
      name: toolName,
      arguments: normalizeArguments(toolName, rawArgs),
    });
    return "";
  });

  // Clean up any remaining empty marker tags or leftover DSML wrappers
  cleanText = cleanText
    .replace(/<[|｜]DSML[|｜][^>]*>/gi, "")
    .replace(/<\/[|｜]DSML[|｜][^>]*>/gi, "")
    .trim();

  return {
    hasToolCalls: toolCalls.length > 0,
    cleanText,
    toolCalls,
  };
}

/**
 * Does this still look like a tool call printed as text?
 *
 * Used as the belt to extractTextToolCalls' braces: when a model's turn ends
 * with markup that could not be recovered into a real call, the session is left
 * holding a call it cannot run — and simply stops. `pi-launch` asks this and
 * tells the model to re-issue the call through the tool-calling API instead.
 */
export function looksLikeToolMarkup(text: string | undefined | null): boolean {
  if (!text) return false;
  if (/[|｜]DSML[|｜]/.test(text)) return true;
  if (/<\/?(?:tool_calls?|function_calls?|tools_call)\b/i.test(text)) return true;
  if (/<(?:invoke|function_call)\s+name\s*=/i.test(text)) return true;
  return false;
}
