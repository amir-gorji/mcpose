/**
 * Factory for connecting to the backend MCP server.
 *
 * Supports two transport modes:
 *  - **stdio** (default): spawns the backend server as a child process.
 *  - **HTTP/SSE**: connects to an already-running HTTP MCP server.
 *
 * Returns a connected `@modelcontextprotocol/sdk` Client, which exposes the
 * full MCP protocol surface (listTools, callTool, listResources, readResource,
 * listPrompts, getPrompt) with exact MCP type fidelity — important for a
 * transparent proxy that must not transform protocol shapes.
 *
 * @module
 */
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

/** Connection options for the backend MCP server. */
export interface BackendConfig {
  /** Shell command to spawn the backend server (e.g., `"node"`). Required when not using `url`. */
  command?: string;
  /** Arguments passed to the command (e.g., `["/path/to/server.mjs"]`). */
  args?: string[];
  /** HTTP/SSE URL of an already-running backend server. Takes precedence over stdio when set. */
  url?: string;
}

export type BackendClient = Client;

/**
 * Creates and connects an MCP client to the backend server.
 *
 * @param config - Backend connection details (stdio or HTTP).
 * @returns A connected MCP SDK Client ready for tool/resource/prompt calls.
 * @throws If neither `command` nor `url` is provided, or if the connection fails.
 */
export async function createBackendClient(
  config: BackendConfig,
): Promise<BackendClient> {
  if (!config.command && !config.url) {
    throw new Error(
      'mcpose: either command or url must be provided in BackendConfig',
    );
  }

  const client = new Client(
    { name: 'mcpose-backend', version: '1.0.0' },
    { capabilities: {} },
  );

  const transport = config.url
    ? new StreamableHTTPClientTransport(new URL(config.url))
    : new StdioClientTransport({
        command: config.command!,
        args: config.args ?? [],
      });

  await client.connect(transport);
  return client;
}
