# js

To install dependencies:

```bash
bun install
```

To run:

```bash
bun run index.ts
```

This project was created using `bun init` in bun v1.2.12. [Bun](https://bun.sh) is a fast all-in-one JavaScript runtime.

## Secure Serve Deployment

- `opencode serve` defaults to a loopback listener. Non-loopback listeners, including the wildcard address selected by `--mdns`, require a non-empty `OPENCODE_SERVER_PASSWORD`.
- Use a high-entropy random password. The default username is `opencode`; override it with `OPENCODE_SERVER_USERNAME` if needed. This is a shared server credential, not a per-user or per-project permission boundary.
- The listener uses HTTP. For remote access, terminate HTTPS at a trusted reverse proxy or use an encrypted tunnel. Keep the HTTP backend bound to loopback or firewalled so clients cannot bypass that boundary. A password alone does not protect plaintext transport.
- Authenticate with the `Authorization: Basic ...` header or the browser's Basic authentication prompt. Long-lived `auth_token` URL credentials are no longer accepted. Do not put passwords in URLs or access logs.
- Desktop terminal connections require the server's short-lived, single-use PTY ticket endpoint. Older servers without ticket support must be upgraded; the client will not fall back to a password-bearing WebSocket URL.
- After 30 completed HTTP 401 responses from one connection address within a 60-second window, further requests from that address receive HTTP 429 until the window expires. Tracking is bounded to 1,024 addresses; when full, the oldest entry is evicted so a flood of addresses cannot lock out clients with valid credentials. An attacker controlling more addresses than that can still rotate past per-address limits, so rely on a high-entropy password rather than the limiter. Forwarded IP headers are not trusted, so clients behind one proxy share the backend limit. Apply per-client limits at the trusted proxy too, including protection against concurrent bursts.
- The external UI fallback forwards only resource-negotiation headers and GET/HEAD requests. If a previous deployment used that fallback with Basic authentication, rotate the password because older versions forwarded the authorization header upstream.
