/**
 * Cross-cutting structured logger. Every layer creates a child logger via
 * `loggerFor(scope)` so log lines from controller → service → repo → SQL all
 * share a `scope` field and any per-call bindings (tenantId, conversationId).
 *
 * In dev (NODE_ENV !== 'production') we route through pino-pretty for a
 * readable, color-tagged terminal. In prod we keep raw JSON for log
 * aggregation.
 */
import pino from 'pino';

const env = process.env.NODE_ENV;
// pino-pretty spawns a worker thread; vitest occasionally flags that as a
// leaked open handle. Skip the transport in production (where we want raw
// JSON for log aggregation) AND in test (where we want quiet, sync output).
const usePrettyTransport = env !== 'production' && env !== 'test';

const root = pino({
  level: process.env.LOG_LEVEL ?? 'info',
  base: undefined,
  ...(usePrettyTransport
    ? {
        transport: {
          target: 'pino-pretty',
          options: {
            colorize: true,
            translateTime: 'HH:MM:ss.l',
            ignore: 'pid,hostname',
            singleLine: false,
          },
        },
      }
    : {}),
});

export type Logger = pino.Logger;

export function loggerFor(scope: string): Logger {
  return root.child({ scope });
}
