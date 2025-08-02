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

const LOG_LEVELS: Record<LogLevel, number> = {
  debug: 0,
  info: 1,
  warn: 2,
  error: 3,
};

/**
 * Creates a logger for the specified module with configurable log level
 */
export function createLogger(
  module: string,
  minLevel: LogLevel = 'info',
): Logger {
  const minLevelValue = LOG_LEVELS[minLevel];

  const shouldLog = (level: LogLevel): boolean =>
    LOG_LEVELS[level] >= minLevelValue;

  const formatMessage = (entry: LogEntry): string => {
    const { level, timestamp, module, message, data } = entry;
    let formatted = `[${timestamp}] [${level.toUpperCase()}] [${module}] ${message}`;

    if (data !== undefined) {
      const dataStr = typeof data === 'string' ? data : JSON.stringify(data);
      formatted += ` ${dataStr}`;
    }

    return formatted;
  };

  const log = (level: LogLevel, message: string, data?: unknown): void => {
    if (!shouldLog(level)) return;

    const entry: LogEntry = {
      level,
      timestamp: new Date().toISOString(),
      module,
      message,
      data,
    };

    console.error(formatMessage(entry));
  };

  return {
    debug: (message: string, data?: unknown) => log('debug', message, data),
    info: (message: string, data?: unknown) => log('info', message, data),
    warn: (message: string, data?: unknown) => log('warn', message, data),
    error: (message: string, data?: unknown) => log('error', message, data),

    withModule: (newModule: string) => createLogger(newModule, minLevel),
  };
}

/**
 * Default logger instance for the application
 */
export const logger = createLogger('ctxvm', getLogLevelFromEnv() || 'error');

/**
 * Get log level from environment variables, handling both Node.js and browser environments
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
