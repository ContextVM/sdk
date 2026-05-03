---
'@contextvm/sdk': patch
---

feat(transport): expose inbound Nostr request event id in MCP requests

Add support for injecting and accessing the inbound Nostr request event ID in MCP request messages via the _meta field. This enables middleware and tools to access the original Nostr event that triggered the request, including the event's pubkey and full event data through a request-scoped context store.