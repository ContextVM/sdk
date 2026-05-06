# CEP-41 SDK Design and Implementation Plan

## Goals

- Add CEP-41 open-ended streams as a first-class transport feature.
- Keep the public API simple, explicit, and composable.
- Preserve low overhead for users who do not need streaming.
- Support concurrent long-lived streams safely on both client and server.

## Design Summary

### Activation model

CEP-41 support is opt-in at two levels:

- **Transport feature enablement** on both [`NostrClientTransport`](../src/transport/nostr-client-transport.ts) and [`NostrServerTransport`](../src/transport/nostr-server-transport.ts).
- **Per-request activation** via MCP `progressToken`, as required by [`cep-41.md`](./cep-41.md:64).

Recommended config shape:

```ts
openStream?: {
  enabled?: boolean;
  policy?: {
    maxConcurrentStreams?: number;
    maxBufferedChunksPerStream?: number;
    maxBufferedBytesPerStream?: number;
    idleTimeoutMs?: number;
    probeTimeoutMs?: number;
    closeGracePeriodMs?: number;
  };
};
```

Initial default:

- `enabled: false`

When disabled:

- do not advertise `support_open_stream`
- do not create stream sessions
- do not expose high-level stream helpers as usable

When enabled but unused:

- no per-stream state is allocated
- only a lightweight registry/manager exists

### Public API

#### Consumer API

Primary API is a free helper function, not a wrapper client class.

```ts
const call = await callToolStream({
  client,
  transport,
  name: 'subscribeToEvents',
  arguments: { topic: 'orders' },
});

for await (const chunk of call.stream) {
  console.log(chunk);
}

const result = await call.result;
```

Recommended return shape:

```ts
interface ToolStreamCall<TChunk = string, TResult = unknown> {
  readonly progressToken: string;
  readonly stream: AsyncIterable<TChunk>;
  readonly result: Promise<TResult>;
  abort(reason?: string): Promise<void>;
}
```

Advanced API remains on [`NostrClientTransport`](../src/transport/nostr-client-transport.ts):

- low-level stream registry
- waiting for streams by `progressToken`
- observing active streams for diagnostics/tests

#### Producer API

Expose a single long-lived stream session in handler context:

```ts
interface ToolStreamSession {
  readonly progressToken: string;
  readonly isActive: boolean;
  readonly closed: Promise<void>;
  write(chunk: string): Promise<void>;
  close(): Promise<void>;
  abort(reason?: string): Promise<void>;
  onClose(handler: () => void | Promise<void>): void;
}

interface ToolHandlerContext {
  stream?: ToolStreamSession;
}
```

This same object supports both:

- inline progressive generation
- detached/live streaming from external async sources

### Key API principles

- Async iterators are the primary read abstraction.
- Writers/sessions are the primary write abstraction.
- The stream lifecycle is distinct from the final JSON-RPC response lifecycle.
- Ping/pong keepalive is internal runtime behavior, not user API.
- CEP-41 is implemented as a sibling subsystem to CEP-22, not a variant of it.

## Runtime Model

### Internal modules

Add a new transport subsystem:

```text
src/transport/open-stream/
├── constants.ts
├── errors.ts
├── frames.ts
├── index.ts
├── receiver.ts
├── registry.ts
├── session.ts
├── types.ts
└── writer.ts
```

### Core responsibilities

The open-stream subsystem owns:

- frame validation
- ordered lifecycle handling
- per-stream session state
- idle timeout and ping/pong probing
- local buffering/resource limits
- cleanup on close/abort/disconnect/probe failure
- coordination between stream termination and final JSON-RPC completion

### Session state

Each active session is keyed by `progressToken` and tracks:

- lifecycle state
- last observed `progress`
- next expected `chunkIndex`
- missing/out-of-order chunks within bounded policy
- buffered consumer chunks
- idle/probe timers
- cleanup callbacks
- final response completion state

## Protocol Mapping

### Capability advertisement

When enabled, advertise `support_open_stream` following [`cep-41.md`](./cep-41.md:40).

Add a new tag constant near [`SUPPORT_OVERSIZED_TRANSFER`](../src/core/constants.ts:118).

### Request activation

Open streaming only applies when the initiating request includes `progressToken`, per [`cep-41.md`](./cep-41.md:64).

### Transport interception points

Mirror the CEP-22 interception pattern at:

- [`NostrClientTransport.handleNotification()`](../src/transport/nostr-client-transport.ts:1012)
- [`NostrServerTransport.authorizeAndProcessEvent()`](../src/transport/nostr-server-transport.ts:1190)

### Correlation

Reuse existing progress-token routing via [`CorrelationStore.getEventIdByProgressToken()`](../src/transport/nostr-server/correlation-store.ts:194).

The final JSON-RPC response must only be sent after the stream reaches `close` or `abort`, consistent with [`cep-41.md`](./cep-41.md:334).

## Usage Patterns

### 1. Inline progressive generation

```ts
server.registerTool('generateText', async (args, ctx) => {
  await ctx.stream?.write('Hello');
  await ctx.stream?.write(' world');
  await ctx.stream?.close();

  return {
    content: [{ type: 'text', text: 'Done' }],
    isError: false,
  };
});
```

### 2. Live subscription backed by websocket/events

```ts
server.registerTool('subscribeToEvents', async (args, ctx) => {
  const stream = ctx.stream;
  if (!stream) {
    return {
      content: [{ type: 'text', text: 'Streaming unavailable' }],
      isError: true,
    };
  }

  const ws = new WebSocket(args.url);

  ws.onmessage = async (event) => {
    if (!stream.isActive) return;
    await stream.write(event.data.toString());
  };

  ws.onerror = async () => {
    if (!stream.isActive) return;
    await stream.abort('Upstream websocket error');
  };

  ws.onclose = async () => {
    if (!stream.isActive) return;
    await stream.close();
  };

  stream.onClose(() => {
    try {
      ws.close();
    } catch {
      // best effort
    }
  });

  return waitForSubscriptionResult();
});
```

This demonstrates that one `ctx.stream` abstraction supports detached, concurrent, long-lived production.

## Keepalive Semantics

Implement keepalive strictly inside the stream session manager per [`cep-41.md`](./cep-41.md:340):

- any valid open-stream frame resets idle timeout
- on idle timeout, send `ping`
- require matching `pong` before probe timeout
- on probe failure, fail the stream and clean up local resources

Application code should not manually manage `ping` or `pong`.

## Performance and Safety

### Non-streaming users

When feature is disabled or unused:

- negligible overhead
- no active session allocations
- no stream timers
- no chunk buffers

### Streaming users

Enforce local limits:

- max concurrent streams
- max buffered chunks/bytes per stream
- bounded out-of-order buffering
- hard idle/probe timeouts
- close-grace timeout for unresolved gaps

One stream must not block unrelated streams.

## Implementation Plan

### Phase 1: types, constants, capability plumbing

1. Add `support_open_stream` constant in [`constants.ts`](../src/core/constants.ts).
2. Extend discovery parsing in [`discovery-tags.ts`](../src/transport/discovery-tags.ts).
3. Add `openStream` options to:
   - [`NostrClientTransport`](../src/transport/nostr-client-transport.ts)
   - [`NostrServerTransport`](../src/transport/nostr-server-transport.ts)

### Phase 2: internal open-stream subsystem

1. Add frame types and errors.
2. Implement frame builders for `start`, `accept`, `chunk`, `ping`, `pong`, `close`, `abort`.
3. Implement session manager/registry.
4. Implement client-side readable stream session.
5. Implement server-side writable stream session.

Representative type sketch:

```ts
export type OpenStreamFrameType =
  | 'start'
  | 'accept'
  | 'chunk'
  | 'ping'
  | 'pong'
  | 'close'
  | 'abort';
```

### Phase 3: transport integration

1. Intercept inbound CEP-41 progress notifications at the same branch points used by CEP-22.
2. Route frames into the open-stream manager.
3. Create server-side stream sessions bound to request `progressToken`.
4. Delay final JSON-RPC completion until stream termination.

Representative interception sketch:

```ts
if (
  isJSONRPCNotification(message) &&
  message.method === 'notifications/progress' &&
  OpenStreamReceiver.isOpenStreamFrame(message)
) {
  await this.openStreamRegistry.processFrame(message);
  return;
}
```

### Phase 4: public APIs

1. Add consumer helper, e.g. [`call-tool-stream.ts`](../src/transport/call-tool-stream.ts).
2. Export helper from [`transport/index.ts`](../src/transport/index.ts) and optionally [`index.ts`](../src/index.ts).
3. Expose advanced client registry access on [`NostrClientTransport`](../src/transport/nostr-client-transport.ts).
4. Inject `ctx.stream` into server/tool execution path.

Representative helper sketch:

```ts
const call = await callToolStream({
  client,
  transport,
  name: 'subscribeToEvents',
  arguments: { topic: 'orders' },
});
```

### Phase 5: tests

Add focused unit and e2e coverage for:

- capability advertisement and negotiation
- accept-gated bootstrap
- zero-chunk streams
- multiple concurrent streams
- live detached production
- ordered and out-of-order chunks
- `close` with missing chunks
- remote and local aborts
- keepalive ping/pong timeout
- cleanup on disconnect/close
- final response strictly after stream termination

## Final Decisions

- CEP-41 is a separate subsystem from CEP-22.
- Consumer primary API is a free helper function.
- Advanced consumer API is a transport-level registry.
- Producer primary API is one long-lived [`ctx.stream`](README.md:64)-style session handle.
- Feature is transport-level opt-in and request-level opt-in.
- Keepalive is internal runtime behavior.
