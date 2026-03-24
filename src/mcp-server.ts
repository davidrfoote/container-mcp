import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";

// Import from domain modules
import { gitToolDefinitions, handleGitTool } from "./tools/git-tools.js";
import { codeExecutionToolDefinitions, handleCodeExecutionTool } from "./tools/code-execution-tools.js";
import { sessionToolDefinitions, handleSessionTool } from "./tools/session-tools.js";
import { projectToolDefinitions, handleProjectTool } from "./tools/project-tools.js";
import { cacheToolDefinitions, handleCacheTool } from "./tools/cache-tools.js";
import { introspectionToolDefinitions, handleIntrospectionTool } from "./tools/introspection-tools.js";

export function createMcpServer() {
  const server = new Server(
    { name: "container-mcp", version: "2.3.0" },
    { capabilities: { tools: {} } }
  );

  const allTools = [
    ...gitToolDefinitions,
    ...codeExecutionToolDefinitions,
    ...sessionToolDefinitions,
    ...projectToolDefinitions,
    ...cacheToolDefinitions,
    ...introspectionToolDefinitions,
  ];

  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: allTools }));

  server.setRequestHandler(CallToolRequestSchema, async (req) => {
    const { name, arguments: args } = req.params;
    const safeArgs = (args ?? {}) as Record<string, unknown>;

    try {
      if (gitToolDefinitions.find((t) => t.name === name)) {
        return handleGitTool(name, safeArgs);
      }
      if (codeExecutionToolDefinitions.find((t) => t.name === name)) {
        return handleCodeExecutionTool(name, safeArgs);
      }
      if (sessionToolDefinitions.find((t) => t.name === name)) {
        return handleSessionTool(name, safeArgs);
      }
      if (projectToolDefinitions.find((t) => t.name === name)) {
        return handleProjectTool(name, safeArgs);
      }
      if (cacheToolDefinitions.find((t) => t.name === name)) {
        return handleCacheTool(name, safeArgs);
      }
      if (introspectionToolDefinitions.find((t) => t.name === name)) {
        return handleIntrospectionTool(name, safeArgs);
      }
      return {
        content: [{ type: "text", text: `Unknown tool: ${name}` }],
        isError: true,
      };
    } catch (e: unknown) {
      const message = e instanceof Error ? e.message : String(e);
      return {
        content: [{ type: "text", text: `Tool error: ${message}` }],
        isError: true,
      };
    }
  });

  return server;
}
