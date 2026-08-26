# The HTTP proxy binds loopback by default and derives enforcing Host and Origin allowlists

`startHttpProxy` used to bind all interfaces when `host` was omitted, with DNS-rebinding protection off.
The default configuration was therefore an unauthenticated MCP proxy listening on every interface while holding a live authenticated, often OAuth, session to an upstream: anything that could route to the host could call the upstream with the operator's credentials.
This was observed live in a production pilot, where a proxy in front of `mcp.sentry.dev` listened on `*:8083` until the consumer passed an explicit `host: '127.0.0.1'` ([#74](https://github.com/amir-gorji/mcpose/issues/74)).
The MCP specification directs local HTTP servers to bind loopback and validate the `Origin` header, so the old default contradicted the specification the library implements.

From `mcpose` 3.0.0, `host` defaults to `127.0.0.1`, and `enableDnsRebindingProtection` defaults to `true` when the effective bind address is loopback and `false` otherwise.

## Why the flag alone is not enough

Enabling `enableDnsRebindingProtection` on its own is a no-op in `@modelcontextprotocol/sdk` 1.30.0: the transport validates the `Host` header only against a non-empty `allowedHosts` and the `Origin` header only against a non-empty `allowedOrigins`.
A consumer who found the option and turned it on gained no protection at all, which is the false-confidence failure mode this whole set of changes exists to remove.
mcpose therefore derives default `allowedHosts` and `allowedOrigins` from the effective bind address and the real listening port, so the default is an enforcing default rather than an inert flag.
For a loopback bind the derived list is `127.0.0.1:<port>`, `localhost:<port>`, and `[::1]:<port>`, plus the matching origins under the scheme the proxy actually serves.
An explicitly supplied `allowedHosts` or `allowedOrigins` is used verbatim and never merged with the derived list.

Binding a non-loopback address is a deliberate opt-in: the consumer has to pass `host: '0.0.0.0'` and mean it.
A non-loopback bind without `resolveIdentity` reports one warning through the existing `onError` hook, falling back to `console.error` to match the existing convention, once per server rather than per request.
No list is derived for a non-loopback bind, because a proxy exposed to a network is usually behind a gateway that rewrites `Host`, and any list mcpose could invent there would be a guess.

## Considered Options

- **Keep the old default and document the risk.** Rejected: a safe default must hold for someone who never read the manual, and the observed pilot deployment proves people do not.
- **Default `enableDnsRebindingProtection` to on without deriving allowlists.** Rejected: the SDK validates nothing against an empty list, so this ships a control that reads like a control and is not one.
- **Merge derived entries into an explicit allowlist.** Rejected: merging makes the effective policy the union of what the consumer wrote and what mcpose guessed, which is impossible to audit from the configuration alone.
- **Refuse to start on a non-loopback bind without `resolveIdentity`.** Rejected: gateway-fronted deployments legitimately terminate identity elsewhere; a hard failure would punish correct architectures to protect careless ones. The warning keeps the signal without the breakage.
- **A new logging mechanism for the warning.** Rejected: `onError` with a `console.error` fallback already exists and is where operators look.

## Consequences

- BREAKING: deployments that relied on the old all-interfaces default must now pass `host: '0.0.0.0'` explicitly. `mcpose` moves from 2.2.0 to 3.0.0.
- A default-configuration proxy is no longer reachable from the network, and a browser page cannot use DNS rebinding to reach it via a forged `Host` or cross-site `Origin`.
- Consumers fronting the proxy with a reverse proxy on loopback whose forwarded `Host` is not a loopback form must set `allowedHosts` explicitly.
- `SECURITY.md` gains a "Network posture" section covering bind address, `Origin` validation, and what the proxy does and does not authenticate.
