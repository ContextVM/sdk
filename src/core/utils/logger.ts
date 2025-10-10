import pino, { Logger as PinoLogger } from 'pino';
import { existsSync, mkdirSync } from 'fs';
import { dirname } from 'path';

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

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
 * Logger configuration from environment variables
 */
interface EnvLoggerConfig {
  level: LogLevel;
  destination: 'stderr' | 'stdout' | 'file';
  filePath?: string;
  enabled: boolean;
}

/**
 * Get logger configuration from environment variables
 * @returns Environment-based logger configuration
 */
function getEnvLoggerConfig(): EnvLoggerConfig {
  // Log level from LOG_LEVEL env var
  const level = getLogLevelFromEnv() || 'info';

  // Destination from LOG_DESTINATION env var (stderr, stdout, file)
  const destination =
    (process.env.LOG_DESTINATION as 'stderr' | 'stdout' | 'file') || 'stderr';

  // File path from LOG_FILE env var when destination is 'file'
  const filePath = process.env.LOG_FILE;

  // Enable/disable logging from LOG_ENABLED env var (default: true)
  const enabled = process.env.LOG_ENABLED !== 'false';

  return {
    level,
    destination,
    filePath,
    enabled,
  };
}

/**
 * Creates a Pino logger instance with the specified configuration
 * @param config - Logger configuration options
 * @returns Configured Pino logger instance
 */
function createPinoLogger(config: LoggerConfig = {}): PinoLogger {
  const envConfig = getEnvLoggerConfig();

  // If logging is disabled, return a silent logger
  if (!envConfig.enabled) {
    return pino({ level: 'silent' });
  }

  // Use explicit config or fall back to environment config
  const logLevel = config.level || envConfig.level;
  const destination = config.file ? 'file' : envConfig.destination;
  const filePath = config.file || envConfig.filePath;

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

  // Determine destination based on configuration
  let pinoDestination;
  if (destination === 'file' && filePath) {
    // If file logging is enabled, ensure directory exists and use file destination
    const dir = dirname(filePath);
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true });
    }
    pinoDestination = pino.destination({ dest: filePath });
  } else if (destination === 'stdout') {
    // Use stdout
    pinoDestination = pino.destination({ dest: 1 }); // 1 is stdout
  } else {
    // Default to stderr for MCP protocol compliance
    pinoDestination = pino.destination({ dest: 2 }); // 2 is stderr
  }

  return pino(
    {
      level: logLevel,
      transport,
      base: {
        env: process.env.NODE_ENV || 'unknown',
        version: process.env.npm_package_version || '0.0.0',
      },
      timestamp: pino.stdTimeFunctions.isoTime,
    },
    pinoDestination,
  );
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
  minLevel: LogLevel = 'info',
  config: LoggerConfig = {},
): Logger {
  // Create the base Pino logger
  const pinoLogger = createPinoLogger({
    ...config,
    level: minLevel,
  });

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

    withModule: (newModule: string) =>
      createLogger(newModule, minLevel, config),
  };
}

/**
 * Default logger instance for the application
 */
export const logger = createLogger('ctxvm', getLogLevelFromEnv() || 'error');

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
