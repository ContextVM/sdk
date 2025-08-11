# @contextvm/sdk

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
