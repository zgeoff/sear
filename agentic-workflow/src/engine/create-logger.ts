import process from 'node:process';
export type LogLevel = 'debug' | 'info' | 'error';

export interface LogEntry {
  timestamp: string;
  level: LogLevel;
  message: string;
  [key: string]: unknown;
}

export type LogWriter = (entry: LogEntry) => void;

export interface Logger {
  debug: (message: string, data?: Record<string, unknown>) => void;
  info: (message: string, data?: Record<string, unknown>) => void;
  error: (message: string, data?: Record<string, unknown>) => void;
}

interface LoggerConfig {
  logLevel: LogLevel;
  writer?: LogWriter;
}

const LOG_LEVEL_PRIORITY: Record<LogLevel, number> = {
  debug: 0,
  info: 1,
  error: 2,
};

export function createLogger(config: LoggerConfig): Logger {
  const threshold = LOG_LEVEL_PRIORITY[config.logLevel];
  const writer = config.writer ?? defaultWriter;

  return {
    debug(message: string, data?: Record<string, unknown>): void {
      if (LOG_LEVEL_PRIORITY.debug >= threshold) {
        writer(buildEntry('debug', message, data));
      }
    },

    info(message: string, data?: Record<string, unknown>): void {
      if (LOG_LEVEL_PRIORITY.info >= threshold) {
        writer(buildEntry('info', message, data));
      }
    },

    error(message: string, data?: Record<string, unknown>): void {
      if (LOG_LEVEL_PRIORITY.error >= threshold) {
        writer(buildEntry('error', message, data));
      }
    },
  };
}

function buildEntry(level: LogLevel, message: string, data?: Record<string, unknown>): LogEntry {
  return {
    timestamp: new Date().toISOString(),
    level,
    message,
    ...data,
  };
}

function defaultWriter(entry: LogEntry): void {
  process.stderr.write(`${JSON.stringify(entry)}\n`);
}
