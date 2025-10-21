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

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  if (typeof window !== 'undefined' && (window as any).LOG_LEVEL) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return (window as any).LOG_LEVEL as LogLevel;
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
 * @param config - Logger configuration options
 * @returns Configured Pino logger instance
 */
function createPinoLogger(config: LoggerConfig = {}): PinoLogger {
  // Use explicit config or fall back to environment config
  const logLevel = config.level || loggerConfig.level;
  const destination = config.file ? 'file' : loggerConfig.destination;
  const filePath = config.file || loggerConfig.filePath;

  // Detect if we're in a Node.js environment
  const isNode = typeof process !== 'undefined';

  // Base pino options
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

  // In browser environments, pino automatically uses console methods
  // No need for pino.destination() or transport configuration
  if (!isNode) {
    return pino(pinoOptions);
  }

  // Node.js-specific configuration
  // Use pretty printing when NOT logging to a file
  const usePrettyPrint = !filePath;

  // Configure transport for pretty printing (only when not logging to file)
  const transport = usePrettyPrint
    ? {
        target: 'pino-pretty',
        options: {
          colorize: true,
          ignore: 'pid,hostname',
          translateTime: 'yyyy-mm-dd HH:MM:ss',
        },
      }
    : undefined;

  // Determine destination based on configuration (Node.js only)
  let pinoDestination;
  if (destination === 'file' && filePath) {
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
  } else if (destination === 'stdout') {
    // Use stdout
    pinoDestination = pino.destination({ dest: 1 }); // 1 is stdout
  } else {
    // Default to stderr for MCP protocol compliance
    pinoDestination = pino.destination({ dest: 2 }); // 2 is stderr
  }

  const logger = pino(
    {
      ...pinoOptions,
      transport,
    },
    pinoDestination,
  );
  return logger;
}

/**
 * Creates a logger for the specified module with configurable log level
 * @param module - The module name for log context
 * @param minLevel - Minimum log level (default: 'info')
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
