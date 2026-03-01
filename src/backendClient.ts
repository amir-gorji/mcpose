/**
 * Backend MCP client factory.
 * Modes: stdio (spawns child process) or HTTP/SSE (connects to running server).
 */
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

/** Backend connection config. */
export interface BackendConfig {
  /** Shell command to spawn backend (e.g. `"node"`). Required if no `url`. */
  command?: string;
  /** Args passed to command (e.g. `["/path/to/server.mjs"]`). */
  args?: string[];
  /** HTTP/SSE URL of running backend. Takes precedence over stdio. */
  url?: string;
}

export type BackendClient = Client;

/**
 * Creates and connects an MCP client to the backend.
 * @throws If neither `command` nor `url` provided, or connection fails.
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
    { name: 'mcpose-backend', version: '1.1.1' },
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
