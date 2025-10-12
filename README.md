# ContextVM SDK

A JavaScript/TypeScript SDK that implements the Context Vending Machine Protocol, bridging Nostr and Model Context Protocol (MCP) to enable decentralized access and exposure of computational services.

## Overview

The ContextVM Protocol defines how Nostr and Model Context Machines can be used to expose MCP server capabilities, enabling standardized usage of these resources through a decentralized, cryptographically secure messaging system.

This SDK provides the necessary components to interact with the ContextVM Protocol:

- **Core Module**: Contains fundamental definitions, constants, interfaces, and utilities (e.g., encryption, serialization).
- **Transports**: Critical for communication, providing `NostrClientTransport` and `NostrServerTransport` implementations for enabling MCP over Nostr.
- **Proxy**: A client-side MCP server that connects to other servers through Nostr, exposing server capabilities locally. Particularly useful for clients that don't natively support Nostr transport.
- **Gateway**: Implements Nostr server transport, binding to another MCP server and exposing its capabilities through the Nostr network.
- **Relay**: Functionality for managing Nostr relays, abstracting relay interactions.
- **Signer**: Provides cryptographic signing capabilities required for Nostr events.

Both the Proxy and Gateway leverage Nostr transports, allowing existing MCP servers to maintain their conventional transports while gaining Nostr interoperability.

## Installation

```bash
npm install @contextvm/sdk
```

**Note:** You can use your preferred package manager to install the SDK.

## Usage

Visit the [ContextVM documentation](https://contextvm.org) for information on how to use ContextVM.

### Logging

The SDK uses Pino for high-performance logging with structured JSON output. By default, logs are written to stderr to comply with the MCP protocol expectations.

#### Basic Usage

```typescript
import { createLogger } from '@contextvm/sdk/core';

// Create a logger for your module
const logger = createLogger('my-module');

logger.info('Application started');
logger.error('An error occurred', { error: 'details' });
```

#### Configuration Options

You can configure the logger with various options:

```typescript
import { createLogger, LoggerConfig } from '@contextvm/sdk/core';

const config: LoggerConfig = {
  level: 'debug', // Minimum log level (debug, info, warn, error)
  file: 'app.log', // Optional: log to a file instead of stderr
};

const logger = createLogger('my-module', 'info', config);
```

**Note:** Pretty printing is automatically enabled when logs are written to stderr/stdout (not to a file) for better readability during development.

#### Environment Variables

The logger respects the following environment variables:

- `LOG_LEVEL`: Sets the minimum log level (default: 'info')
- `LOG_DESTINATION`: Sets where logs are written - 'stderr' (default), 'stdout', or 'file'
- `LOG_FILE`: File path when `LOG_DESTINATION` is set to 'file'
- `LOG_ENABLED`: Enable/disable logging entirely - 'true' (default) or 'false'

#### Environment-based Configuration Examples

```bash
# Log to stderr with pretty printing (default)
LOG_LEVEL=info node app.js

# Log to stdout with pretty printing
LOG_DESTINATION=stdout node app.js

# Log to a file (pretty printing automatically disabled for file output)
LOG_DESTINATION=file LOG_FILE=./logs/app.log node app.js

# Completely disable logging
LOG_ENABLED=false node app.js
```

#### Module-specific Loggers

Create child loggers for different modules to add context:

```typescript
const baseLogger = createLogger('my-app');
const authLogger = baseLogger.withModule('auth');
const dbLogger = baseLogger.withModule('database');

authLogger.info('User login attempt');
dbLogger.debug('Query executed', { query: 'SELECT * FROM users' });
```

## Development

This project requires [Bun](https://bun.sh/) (version 1.2.0 or higher).

1. Clone the repository:

```bash
git clone https://github.com/ContextVM/ts-sdk.git
cd ts-sdk
```

2. Install dependencies:

```bash
bun install
```

### Running Tests

To run the test suite, use Bun:

```bash
bun tests
```
