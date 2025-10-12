# @contextvm/sdk

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
