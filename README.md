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

const logger = createLogger('my-module', config);
```

**Note:** Pretty printing is automatically enabled when logs are written to stderr/stdout (not to a file) for better readability during development.

#### Configuring with Environment Variables

The logger can be configured using environment variables, which is useful for adjusting log output without changing the code.

- **`LOG_LEVEL`**: Sets the minimum log level.
  - **Values**: `debug`, `info`, `warn`, `error`.
  - **Default**: `info`.
- **`LOG_DESTINATION`**: Sets the log output destination.
  - **Values**: `stderr` (default), `stdout`, or `file`.
- **`LOG_FILE`**: Specifies the file path when `LOG_DESTINATION` is `file`.
- **`LOG_ENABLED`**: Enables or disables logging.
  - **Values**: `true` (default) or `false`.

##### Configuration in Node.js

Set the variables in your shell before running the application:

```bash
# Set log level to debug
LOG_LEVEL=debug node app.js

# Log to a file instead of the console
LOG_DESTINATION=file LOG_FILE=./app.log node app.js

# Disable logging entirely
LOG_ENABLED=false node app.js
```

##### Configuration in Browsers

In a browser environment, you can configure the log level by setting a global `LOG_LEVEL` variable on the `window` object **before** the SDK is imported or used.

```javascript
// Set this in a <script> tag in your HTML or at the top of your entry point
window.LOG_LEVEL = 'debug';

// Now, when you import and use the SDK, it will use the 'debug' log level.
import { logger } from '@contextvm/sdk';
logger.debug('This is a debug message.');
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
