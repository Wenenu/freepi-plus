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

  return args;
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
  const dsmlBlockRegex = /<[|｜]DSML[|｜]tools?_call>([\s\S]*?)<\/[|｜]DSML[|｜]tools?_call>/gi;
  cleanText = cleanText.replace(dsmlBlockRegex, (_, blockContent) => {
    // Find each tool invocation inside the DSML block
    // Can be <｜DSML｜bash_tool> ... </｜DSML｜...>, or <｜DSML｜invoke name="...">
    const toolRegex = /<[|｜]DSML[|｜](?:call:|invoke\s+name=["']?([^"'>\s]+)["']?|([a-zA-Z0-9_-]+)_tool)>([\s\S]*?)(?:<\/[|｜]DSML[|｜](?:invoke|call:[^>]+|\2_tool|tool_call)>|$)/gi;
    let match: RegExpExecArray | null;
    while ((match = toolRegex.exec(blockContent)) !== null) {
      const rawTool = match[1] || match[2] || "bash";
      const body = match[3] || "";
      const rawArgs: Record<string, any> = {};

      // Extract parameters inside this tool block
      const paramRegex = /<[|｜]DSML[|｜]parameter\s+name=["']?([^"'>\s]+)["']?>([\s\S]*?)<\/[|｜]DSML[|｜]parameter>/gi;
      let pMatch: RegExpExecArray | null;
      let hasParams = false;
      while ((pMatch = paramRegex.exec(body)) !== null) {
        hasParams = true;
        const pName = pMatch[1].trim();
        const pValue = pMatch[2].trim();
        rawArgs[pName] = pValue;
      }

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
  const dsmlLooseRegex = /<[|｜]DSML[|｜](?:call:|invoke\s+name=["']?([^"'>\s]+)["']?|([a-zA-Z0-9_-]+)_tool)>([\s\S]*?)<\/[|｜]DSML[|｜](?:invoke|call:[^>]+|\2_tool|tool_call)>/gi;
  cleanText = cleanText.replace(dsmlLooseRegex, (_, m1, m2, body) => {
    const rawTool = m1 || m2 || "bash";
    const rawArgs: Record<string, any> = {};
    const paramRegex = /<[|｜]DSML[|｜]parameter\s+name=["']?([^"'>\s]+)["']?>([\s\S]*?)<\/[|｜]DSML[|｜]parameter>/gi;
    let pMatch: RegExpExecArray | null;
    while ((pMatch = paramRegex.exec(body)) !== null) {
      rawArgs[pMatch[1].trim()] = pMatch[2].trim();
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
  const invokeRegex = /<(?:invoke|call)\s+name=["']?([^"'>\s]+)["']?>([\s\S]*?)<\/(?:invoke|call)>/gi;
  cleanText = cleanText.replace(invokeRegex, (_, rawTool, body) => {
    const rawArgs: Record<string, any> = {};
    const paramRegex = /<parameter\s+name=["']?([^"'>\s]+)["']?>([\s\S]*?)<\/parameter>/gi;
    let pMatch: RegExpExecArray | null;
    let hasParams = false;
    while ((pMatch = paramRegex.exec(body)) !== null) {
      hasParams = true;
      rawArgs[pMatch[1].trim()] = pMatch[2].trim();
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
      arguments: normalizeArguments(toolName, rawArgs),
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
