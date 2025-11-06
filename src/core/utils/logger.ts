import pino, { Logger as PinoLogger } from 'pino';

export type LogLevel = 'debug' | 'info' | 'warn' | 'error' | 'silent';

export interface LogEntry {
  level: LogLevel;
  timestamp: string;
  module: string;
  message: string;
  data?: unknown;
}

export interface Logger {
  debug(message: string, data?: unknown): void;
  info(message: string, data?: unknown): void;
  warn(message: string, data?: unknown): void;
  error(message: string, data?: unknown): void;
  withModule(newModule: string): Logger;
}

/**
 * Configuration options for the logger
 */
export interface LoggerConfig {
  /** Minimum log level to output */
  level?: LogLevel;
  /** Optional file path to write logs to. If not specified, logs go to stderr with pretty printing */
  file?: string;
}

/**
 * Get log level from environment variables, handling both Node.js and browser environments
 * @returns The log level from environment or undefined
 */
function getLogLevelFromEnv(): LogLevel | undefined {
  if (typeof process !== 'undefined' && process.env && process.env.LOG_LEVEL) {
    return process.env.LOG_LEVEL as LogLevel;
  }

  // Browser environment check (only if globalThis.window exists)
  if (typeof globalThis !== 'undefined' && 'window' in globalThis) {
    const globalWindow = globalThis.window as { LOG_LEVEL?: string };
    if (globalWindow.LOG_LEVEL) {
      return globalWindow.LOG_LEVEL as LogLevel;
    }
  }

  return undefined;
}

/**
 * Singleton logger configuration instance
 */
const loggerConfig = (() => {
  const level = getLogLevelFromEnv() || 'info';
  const destination =
    (typeof process !== 'undefined' && process.env
      ? (process.env.LOG_DESTINATION as 'stderr' | 'stdout' | 'file')
      : undefined) || 'stderr';
  const filePath =
    typeof process !== 'undefined' && process.env
      ? process.env.LOG_FILE
      : undefined;
  const enabled =
    typeof process !== 'undefined' && process.env
      ? process.env.LOG_ENABLED !== 'false'
      : true;

  return {
    level: enabled ? level : 'silent',
    destination,
    filePath,
  };
})();

/**
 * Creates a Pino logger instance with the specified configuration
 * Uses Pino's built-in browser support for browser environments
 * @param config - Logger configuration options
 * @returns Configured Pino logger instance
 */
function createPinoLogger(config: LoggerConfig = {}): PinoLogger {
  const logLevel = config.level || loggerConfig.level;
  const destination = config.file ? 'file' : loggerConfig.destination;
  const filePath = config.file || loggerConfig.filePath;

  // Base pino options that work in both Node.js and browser
  const pinoOptions = {
    level: logLevel,
    base: {
      env:
        typeof process !== 'undefined' && process.env
          ? process.env.NODE_ENV || 'unknown'
          : 'unknown',
      version:
        typeof process !== 'undefined' && process.env
          ? process.env.npm_package_version || '0.0.0'
          : '0.0.0',
    },
    timestamp: pino.stdTimeFunctions.isoTime,
  };

  // For browser builds, use Pino's built-in browser configuration
  // This automatically uses console methods and avoids Node.js dependencies
  const isNode = typeof process !== 'undefined' && process.versions?.node;

  if (!isNode) {
    // Browser environment - use Pino's native browser support
    return pino({
      ...pinoOptions,
      browser: {
        // Use console methods directly - this is the simplest and most compatible approach
        asObject: false,
      },
    });
  }

  // Determine destination based on configuration (Node.js only)
  let pinoDestination;

  // Only use file destination in Node.js environment
  if (destination === 'file' && filePath) {
    try {
      // If file logging is enabled, ensure directory exists and use file destination
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const { existsSync, mkdirSync } = require('fs');
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const { dirname } = require('path');
      const dir = dirname(filePath);
      if (!existsSync(dir)) {
        mkdirSync(dir, { recursive: true });
      }
      pinoDestination = pino.destination({
        dest: filePath,
        minLength: 1,
      });
    } catch (error) {
      // Fall back to stderr if file operations fail
      console.warn('File logging failed, falling back to stderr:', error);
      pinoDestination = pino.destination({ dest: 2 });
    }
  } else if (destination === 'stdout') {
    // Use stdout
    pinoDestination = pino.destination({ dest: 1 }); // 1 is stdout
  } else {
    // Default to stderr for MCP protocol compliance
    pinoDestination = pino.destination({ dest: 2 }); // 2 is stderr
  }

  return pino(pinoOptions, pinoDestination);
}

/**
 * Creates a logger for the specified module with configurable log level
 * @param module - The module name for log context
 * @param config - Optional logger configuration
 * @returns Logger instance with module context
 */
export function createLogger(
  module: string,
  config: LoggerConfig = {},
): Logger {
  // Create the base Pino logger
  const pinoLogger = createPinoLogger(config);

  // Create a child logger with module context
  const moduleLogger = pinoLogger.child({ module });

  return {
    debug: (message: string, data?: unknown) => {
      if (data) {
        moduleLogger.debug(data, message);
      } else {
        moduleLogger.debug(message);
      }
    },
    info: (message: string, data?: unknown) => {
      if (data) {
        moduleLogger.info(data, message);
      } else {
        moduleLogger.info(message);
      }
    },
    warn: (message: string, data?: unknown) => {
      if (data) {
        moduleLogger.warn(data, message);
      } else {
        moduleLogger.warn(message);
      }
    },
    error: (message: string, data?: unknown) => {
      if (data) {
        moduleLogger.error(data, message);
      } else {
        moduleLogger.error(message);
      }
    },

    withModule: (newModule: string) => createLogger(newModule, config),
  };
}

/**
 * Default logger instance for the application
 */
export const logger = createLogger('ctxvm');
