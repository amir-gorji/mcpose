/**
 * Shared session registry: the transport-level record of live session ids,
 * so a resume can survive a proxy restart or reach another instance (#155).
 */
import * as http from 'node:http';
import * as net from 'node:net';
import type { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import {
  isInitializeRequest,
  type InitializeRequestParams,
} from '@modelcontextprotocol/sdk/types.js';
import type { Identity } from './identity.js';

/**
 * Everything another instance needs to take over a session. Plain JSON: an
 * adapter serializes it as is, so `identity.claims` must survive a JSON
 * round-trip.
 */
export interface SessionRecord {
  /**
   * The client's `initialize` params, verbatim. A resuming instance replays
   * them into a fresh SDK transport, so the rebuilt session negotiates exactly
   * what the original did: protocol version, client capabilities, clientInfo.
   */
  initialize: InitializeRequestParams;
  /**
   * The identity `resolveIdentity` produced at initialize. Never re-resolved
   * on resume; `validateSession` still runs on every routed request.
   */
  identity?: Identity;
  /**
   * Epoch milliseconds after which the session is dead on every instance.
   * Fixed at creation from `sessionTtlMs` and absent when that is `Infinity`.
   * A resuming instance honours the remaining lifetime, not its own TTL.
   */
  expiresAt?: number;
}

/**
 * Where `startHttpProxy` keeps its session records when one is supplied. The
 * local in-memory map stays authoritative for sessions this instance holds;
 * the registry is consulted only for an id this instance does not know.
 *
 * `@mcpose/store-redis` and `@mcpose/store-postgres` ship implementations
 * alongside their `EventStore`s. Share the event store too, or a resumed
 * session has a live id and no replay history.
 */
export interface SessionRegistry {
  /**
   * Persists a record. Awaited before the client learns its session id, so a
   * rejection fails the initialize with a 500 rather than handing out an id
   * that no other instance could honour.
   */
  set(sessionId: string, record: SessionRecord): Promise<void>;
  /** `undefined` for an unknown or expired id. */
  get(sessionId: string): Promise<SessionRecord | undefined>;
  /**
   * Called on client DELETE and TTL expiry. Never on server shutdown: a
   * session that outlives the process is the point of the registry.
   */
  delete(sessionId: string): Promise<void>;
}

/**
 * Pulls the `initialize` params out of a POST body the SDK has already
 * accepted as an initialize request, so a parse failure here is a bug in the
 * SDK's acceptance, not client input to be tolerated.
 */
export function initializeParamsOf(body: string): InitializeRequestParams {
  const parsed: unknown = JSON.parse(body);
  const messages = Array.isArray(parsed) ? parsed : [parsed];
  const initialize = messages.find(isInitializeRequest);
  if (initialize === undefined) {
    throw new Error('mcpose: initialize request not found in accepted body');
  }
  return initialize.params;
}

/**
 * Drives a fresh transport through the SDK's own initialize path with the
 * stored params, so it accepts `sessionId` on later requests. The SDK cannot
 * rehydrate a transport and its initialized flag is private, so the public
 * request path is the one that survives an SDK bump.
 *
 * The request never touches a socket: the SDK's Node adapter reads method,
 * url, headers and the body stream, and the response is captured rather than
 * written anywhere. `Host` and `Origin` are copied from the request being
 * resumed so the transport's DNS-rebinding check sees what the client sent.
 *
 * @returns the status and body the SDK answered, for the caller to relay if
 * the transport did not come up.
 */
export function replayInitialize(
  transport: StreamableHTTPServerTransport,
  params: InitializeRequestParams,
  headers: { host?: string; origin?: string },
): Promise<{ status: number; body: string }> {
  const body = JSON.stringify({
    jsonrpc: '2.0',
    id: 0,
    method: 'initialize',
    params,
  });
  const req = new http.IncomingMessage(new net.Socket());
  req.method = 'POST';
  req.url = '/';
  req.headers = {
    'content-type': 'application/json',
    'content-length': String(Buffer.byteLength(body)),
    accept: 'application/json, text/event-stream',
    ...(headers.host === undefined ? {} : { host: headers.host }),
    ...(headers.origin === undefined ? {} : { origin: headers.origin }),
  };
  // The SDK's adapter reads the raw header list, not the parsed record.
  req.rawHeaders = Object.entries(req.headers).flatMap(([name, value]) => [
    name,
    String(value),
  ]);
  req.push(body);
  req.push(null);

  const res = new http.ServerResponse(req);
  let out = '';
  const append = (chunk: unknown): void => {
    if (typeof chunk === 'string') out += chunk;
    else if (chunk instanceof Uint8Array) out += Buffer.from(chunk).toString();
  };
  // No socket: a real write would buffer forever and report back-pressure,
  // and 'finish' would never fire. Capture instead.
  res.write = (chunk: unknown) => {
    append(chunk);
    return true;
  };
  const done = new Promise<{ status: number; body: string }>((resolve) => {
    res.end = ((chunk?: unknown) => {
      append(chunk);
      resolve({ status: res.statusCode, body: out });
      return res;
    }) as typeof res.end;
  });
  return transport.handleRequest(req, res).then(() => done);
}
