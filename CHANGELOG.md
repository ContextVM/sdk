# @contextvm/sdk

## 0.1.40

### Patch Changes

- feat: implement robust relay reconnection for transports
  - Fix relay restart issue in ApplesauceRelayPool by increasing publishTimeout and leveraging Applesauce's built-in reconnection
  - Add comprehensive reconnection tests covering basic restarts, multiple restarts, and extended outages
  - Simplify logging and reduce verbosity while maintaining essential debugging
  - Ensure server transport can publish messages seamlessly after relay restarts

## 0.1.39

### Patch Changes

- refactor(async): improve reconnection handling, async architecture improvements
  - Add observability for relay connection state monitoring in ApplesauceRelayPool
  - Add test for server restart and continued request processing in NostrClientTransport
  - Update dependencies in package.json and bun.lock
  - Add TaskQueue utility for non-blocking event processing with configurable concurrency
  - Parallelize transport startup operations using Promise.all for reduced latency
  - Implement LRU cache for session and request management with fixed capacity
  - Optimize authorization lookup from O(N) to O(1) using Set
  - Update notification broadcasting to use TaskQueue for backpressure handling
  - Create reusable LruCache utility eliminating code duplication

## 0.1.38

### Patch Changes

- fix(logger): resolve browser build compatibility with Pino.js
  - Refactor logger to use Pino's built-in browser configuration
  - Add environment detection to isolate Node.js-specific code
  - Maintain file logging support in Node.js while enabling browser builds
  - Ensure consistent API across both environments without breaking changes

## 0.1.37

### Patch Changes

- fix(logger): detect enviroment

## 0.1.36

### Patch Changes

- fix(logger): lintin error, and handle pino pretty gracefully

## 0.1.35

### Patch Changes

- fix(logger): add fallback for missing pino-pretty
  - Gracefully handle missing pino-pretty dependency by implementing try-catch fallback to basic JSON logging

## 0.1.34

### Patch Changes

- refactor(logger): Improve logger configuration and instance-based logging
  - Refactor logger configuration to use singleton pattern for better performance
  - Add 'silent' log level option for complete log suppression
  - Change transport classes to use instance-specific loggers with configurable levels
  - Remove redundant environment variable handling functions
  - Simplify logger creation process and improve configuration management
  - Update all transport classes to pass module names and log levels to logger instances

## 0.1.33

### Patch Changes

- fix: pino logger in browser enviroments

## 0.1.32

### Patch Changes

- fix: pino logger in browser enviroments

## 0.1.31

### Patch Changes

- chore: bump version

## 0.1.30

### Patch Changes

- 2f8d260: fix(relay): update applesauce-relay to v4 and adapt API usage
  - Update applesauce-relay dependency from v3.1.0 to v4.0.0
  - Adapt RelayPool constructor to use new Relay API with publishTimeout
  - Add detailed logging for better debugging of relay operations
  - Add test case for handling offline relays in the pool

## 0.1.30-rc.2

### Patch Changes

- fix(transport): improve session management and error handling

## 0.1.30-rc.1

### Patch Changes

- Fix crash handling and improve error logging in Nostr transports:
  - Fix Pino buffered writes to prevent log loss during crashes
  - Add comprehensive error handlers to all async operations
  - Wrap major async flows in try-catch blocks with detailed logging
  - Add periodic cleanup of inactive client sessions to prevent memory leaks
  - Enhance error context logging with stack traces and relevant identifiers
  - Apply consistent error handling patterns across all transport layers

## 0.1.30-rc.0

### Patch Changes

- Release candidate for testing - next

## 0.1.29

### Patch Changes

- 08be76f: feat(transport): add stateless mode support for nostr client transport
- fc91d44: chore: bump versions
- 34058d4: fix(auth): handle unauthorized requests in public server

## 0.1.28

### Patch Changes

- refactor(nostr-server-transport): check if excluded capabilities have length to proceed with the validation
- f127712: chore: log new sessions just when they are created

## 0.1.27

### Patch Changes

- fix(nostr-server-transport): unauthorized errors due to not validating notifications

## 0.1.26

### Patch Changes

- feat(transport): feat(transport): add capability exclusion for whitelisting

  Add support for excluding specific capabilities from public key whitelisting
  requirements, allowing certain operations from disallowed public keys. This
  enhances security policy flexibility while maintaining backward compatibility.

  The implementation includes:
  - CapabilityExclusion interface and excludedCapabilities option
  - isCapabilityExcluded method for exclusion checks
  - Updated authorization logic
  - New test to verify exclusion behavior

## 0.1.25

### Patch Changes

- chore: bump applesauce-relay to latest

## 0.1.24

### Patch Changes

- fix(transport): enhance event validation and disconnect handling

## 0.1.23

### Patch Changes

- feat(transport): add announcement deletion capability and improve event filtering

## 0.1.22

### Patch Changes

- refactor(transport): improve initialization timeout handling

## 0.1.21

### Patch Changes

- refactor(transport): improve initialization process

## 0.1.20

### Patch Changes

- refactor(server-transport): improve logging with logger.info

## 0.1.19

### Patch Changes

- refactor(transport): replace bun import with internal utils

## 0.1.18

### Patch Changes

- refactor: add complete initialization lifecycle for announcements, rename mcpServerTransport to mcpClientTransport in gateway

## 0.1.17

### Patch Changes

- feat(relay): remove nostrify library integration and added ApplesauceRelayPool implementation

## 0.1.16

### Patch Changes

- feat(relay): add nostrify library integration and NostrifyRelayPool implementation

## 0.1.15

### Patch Changes

- chore: bump packages versions
- feat(private-key-signer) Allow undefined to generate new secret key

## 0.1.14

### Patch Changes

- feat(nostr): add about tag support and store initialization event in client transport, refactor tag generation

## 0.1.13

### Patch Changes

- fix: logger in browser env

## 0.1.12

### Patch Changes

- ee82a52: feat: improve relay reconnection handling with subscription persistence
- eecd6af: fix: handle malformed json content in nostr events gracefully
- dd8f444: feat: implement structured logging system with configurable levels
- c18f47c: refactor: nostr signer with nip44 encryption and remove direct secret key access
- 636b197: chore: bump deps
- d5fd1a8: feat: add message validation and relay reconnection with exponential backoff

## 0.1.11

### Patch Changes

- fix: server transport message format mirroring
