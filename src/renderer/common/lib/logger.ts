import pino, { type Logger } from "pino/browser";

export const logger: Logger = pino({
  name: "blueberry",
  level: "info",
  browser: {
    asObject: true,
  },
});

export const createLogger = (module: string): Logger =>
  logger.child({ module });
