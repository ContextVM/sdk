---
'@contextvm/sdk': minor
---

Add CEP-41 open-ended stream transfer support over ContextVM transport.

This introduces open-stream framing over MCP [`notifications/progress`](docs/cep-41.md:10) using the request `progressToken` as the stream identifier, with support for `start`, `accept`, `chunk`, `ping`, `pong`, `close`, and `abort` frames.

It also adds SDK support for:

- client and server open-stream transport handling
- stream session lifecycle management, buffering, and keepalive timeouts
- ergonomic tool streaming via [`callToolStream()`](src/transport/call-tool-stream.ts:28)
- CEP-41 coverage across unit and end-to-end transport tests
