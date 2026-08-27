# The tool catalog is an egress channel, sanitized by an opt-in middleware

`tools/list` forwards upstream tool names, descriptions, and input/output schemas verbatim, and clients paste all of it into model context ([#82](https://github.com/amir-gorji/mcpose/issues/82)).
Real upstreams leak through that channel: descriptions carry documentation URLs with org slugs, internal hostnames, and instance identifiers, and schema `description` fields carry the same.
Anything that reaches model context can be exfiltrated by a prompt-injected agent, so the catalog is an egress channel, not just documentation.

The mitigation is `sanitizeToolDescriptions()`, an opt-in `ListToolsMiddleware`.
It sanitizes `tool.description` and every string-valued `description` property nested in `inputSchema` and `outputSchema`.
It always strips http(s) URLs, and `patterns` (literal strings or regexes, normalized to global) adds deployment-specific identifiers.
Names, titles, and schema structure are deliberately untouched, because clients route calls on them.
Consumers place it last in `listToolsMiddleware` so it also sanitizes what other list middleware and local tools add.

## Considered Options

- **Sanitize on by default.** Rejected: unlike the `_meta` strips (ADR-0008, ADR-0009), descriptions are part of the advertised tool contract, and for a trusted upstream the documentation links are legitimate and load-bearing for the model. A default strip would silently degrade every well-behaved deployment to protect the subset with sensitive upstreams.
- **Rewrite names and schema shapes too.** Rejected: clients dispatch on tool names and validate arguments against schema structure, so rewriting either breaks routing and argument construction. Description text is the only field the model reads but the client does not route on.
- **A fixed built-in denylist of sensitive patterns.** Rejected: what counts as sensitive is deployment-specific (org slugs, hostnames), and a shipped list would grow forever while matching nobody's actual environment. The URL strip is the one universal case, so it is built in; everything else is `patterns`.

## Consequences

- Deployments with sensitive upstreams must opt in; the SECURITY.md section documents the exposure so they know to.
- Sanitized catalogs lose documentation links, which is the point; trusted-upstream deployments simply do not enable it.
- The walk rebuilds only what changed and returns the original result object when nothing matched, so an all-clean catalog costs no allocation.
