import {
  OAuthClientProvider,
  UnauthorizedError,
} from '@modelcontextprotocol/sdk/client/auth';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type {
  OAuthClientInformationFull,
  OAuthClientMetadata,
  OAuthTokens,
} from '@modelcontextprotocol/sdk/shared/auth.js';
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

const CALLBACK_PORT: number = 3003;
const CALLBACK_PATH: string = '/login-callback';
const REDIRECT_URL = `http://localhost:${CALLBACK_PORT}${CALLBACK_PATH}`;
const CLIENT_NAME = 'oauth-solution';
/** Where the dynamically-registered client + tokens + PPKCE verifier are persisted. */
const DEFAULT_STORE_PATH = join(homedir(), `.${CLIENT_NAME}`, 'oauth.json');

type Store = {
  client?: OAuthClientInformationFull;
  tokens?: OAuthTokens;
  verifier?: string;
};

/** Node/CLI implementation of the MCP SDK's Oauth client provider.
 *
 * Replicates what VS Code does for a remote MCP server: dynamic client
 * registration, PKCE, opening the system browser to authorize, and persisting
 * the resulting tokens (with automatic refresh handled by the SDK transport).
 */
export class NodeOAuthProvider implements OAuthClientProvider {
  constructor(private readonly storePath: string = DEFAULT_STORE_PATH) {}

  private read(): Store {
    return existsSync(this.storePath)
      ? (JSON.parse(readFileSync(this.storePath, 'utf8')) as Store)
      : {};
  }

  private write(patch: Partial<Store>): void {
    mkdirSync(dirname(this.storePath), { recursive: true });
    writeFileSync(
      this.storePath,
      JSON.stringify({ ...this.read(), ...patch }, null, 2),
      { mode: 0o600 },
    );
  }

  get redirectUrl(): string {
    return REDIRECT_URL;
  }

  get clientMetadata(): OAuthClientMetadata {
    return {
      client_name: CLIENT_NAME,
      redirect_uris: [REDIRECT_URL],
      grant_types: ['authorization_code', 'refresh_token'],
      token_endpoint_auth_method: 'none',
    };
  }

  clientInformation(): OAuthClientInformationFull | undefined {
    return this.read().client;
  }

  saveClientInformation(client: OAuthClientInformationFull): void {
    this.write({ client });
  }

  tokens(): OAuthTokens | undefined {
    return this.read().tokens;
  }

  saveTokens(tokens: OAuthTokens): void {
    this.write({ tokens });
  }

  saveCodeVerifier(verifier: string): void {
    this.write({ verifier });
  }

  codeVerifier(): string {
    const { verifier } = this.read();
    if (!verifier) {
      throw new Error('No PKCE code_verifier saved');
    }
    return verifier;
  }

  redirectToAuthorization(authorizationUrl: URL): void {
    openBrowser(authorizationUrl.toString());
  }
}

/** Opens the given URL in the system browser without invokig a shell. */
function openBrowser(url: string): void {
  const platform = process.platform;
  const command =
    platform === 'darwin' ? 'open' : platform === 'win32' ? 'cmd' : 'xdg-open';
  const args = platform === 'win32' ? ['/c', 'start', '', url] : [url];
  spawn(command, args, { stdio: 'ignore', detached: true }).unref();
  console.error('\nIf your browser did not open, authorize here:\n${url}\n');
}

/**
 * Start a loopback HTTP server that captures the OAuth redirect and resolves with the authorization code.
 */
function waitForCallback(): {
  codePromise: Promise<string>;
  close: () => void;
} {
  let resolve!: (code: string) => void;
  let reject!: (err: Error) => void;
  const codePromise = new Promise<string>((res, rej) => {
    resolve = res;
    reject = rej;
  });

  const serveer = createServer((req, res) => {
    const requestUrl = new URL(req.url ?? '', REDIRECT_URL);
    if (requestUrl.pathname !== CALLBACK_PATH) {
      res.writeHead(404).end();
      return;
    }
    const error = requestUrl.searchParams.get('error');
    const code = requestUrl.searchParams.get('code');
    res.writeHead(200, { 'content-type': 'text/html' });
    if (error) {
      res.end('<h1>Authentication failed</h1><p>You can close this tab.</p>');
      reject(new Error(`OAuth error: ${error}`));
      return;
    }
    if (!code) {
      res.end(
        '<h1>Missing authorization code</h1><p>You can cllose this tab.</p>',
      );
      reject(new Error('OAuth callback did not include a "code" parameter'));
      return;
    }
    res.end(
      '<h1>Authentication complete</h1><p>You can close this tab and return to the terminal.</p>',
    );
    resolve(code);
  });

  serveer.on('error', (err) => reject(err));
  serveer.listen(CALLBACK_PORT);
  // Keep Node from warning about an unhandled rejection when the caller never needs the code
  // (e.g. cached tokens are still valid).
  codePromise.catch(() => undefined);

  return { codePromise, close: () => serveer.close() };
}

/**
 * Connects to a remote MCP server using browser-based OAuth, exactly like VS Code does.
 * On the first run, it opens the browser to authorize. On later runs
 * it reuses (and silently refreshses) the persisted tokens.
 */
export async function connectWithBrowserAuth(
  serverUrl: string,
  // The link to the http upstream server that requires OAuth login
  authProvider: OAuthClientProvider,
): Promise<Client> {
  const clientInfo = { name: CLIENT_NAME, version: '1.0.0' };
  const { codePromise, close } = waitForCallback();

  try {
    const transport = new StreamableHTTPClientTransport(new URL(serverUrl), {
      authProvider,
    });

    try {
      const client = new Client(clientInfo);
      await client.connect(transport);
      // Reached only when persisted tokens are still valid (or auto-refreshed).
      return client;
    } catch (err) {
      if (!(err instanceof UnauthorizedError)) {
        throw err;
      }
      // `conect` opened the browser via redirectToAuthorization; wait for the redirect;
      // exchange the code for tokens, then reconnect. A transport can only be stated once.
      // So the reconnect uses a fresh transport that now reads the freshly-saved access token.
      console.error('Waiting for browser authorization...');
      const code = await codePromise;
      await transport.finishAuth(code);

      const client = new Client(clientInfo);
      const authedTransport = new StreamableHTTPClientTransport(
        new URL(serverUrl),
        { authProvider },
      );
      await client.connect(authedTransport);
      return client;
    }
  } finally {
    close();
  }
}
