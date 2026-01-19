import { describe, it, expect } from 'bun:test';
import { StatelessModeHandler } from './stateless-mode-handler.js';
import { InitializeResult } from '@modelcontextprotocol/sdk/types.js';
import {
  INITIALIZE_METHOD,
  NOTIFICATIONS_INITIALIZED_METHOD,
} from '@contextvm/sdk/core/constants.js';

describe('StatelessModeHandler', () => {
  describe('createEmulatedResponse', () => {
    it('returns response with correct request id', () => {
      const handler = new StatelessModeHandler();
      const response = handler.createEmulatedResponse('test-id');
      expect(response.id).toBe('test-id');
      expect(response.jsonrpc).toBe('2.0');
      expect((response.result as InitializeResult).serverInfo.name).toBe(
        'Emulated-Stateless-Server',
      );
    });
  });

  describe('shouldHandleStatelessly', () => {
    it('returns true for initialize request', () => {
      const handler = new StatelessModeHandler();
      const result = handler.shouldHandleStatelessly({
        jsonrpc: '2.0' as const,
        id: 1,
        method: INITIALIZE_METHOD,
      });
      expect(result).toBe(true);
    });

    it('returns true for notifications/initialized', () => {
      const handler = new StatelessModeHandler();
      const result = handler.shouldHandleStatelessly({
        jsonrpc: '2.0' as const,
        method: NOTIFICATIONS_INITIALIZED_METHOD,
      });
      expect(result).toBe(true);
    });

    it('returns false for other methods', () => {
      const handler = new StatelessModeHandler();
      const result = handler.shouldHandleStatelessly({
        jsonrpc: '2.0' as const,
        id: 1,
        method: 'tools/list',
      });
      expect(result).toBe(false);
    });
  });
});
