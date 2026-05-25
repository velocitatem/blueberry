import { is } from "@electron-toolkit/utils";
import pino, { type Logger } from "pino";

const level = process.env.LOG_LEVEL ?? (is.dev ? "debug" : "info");

const transport = is.dev
  ? {
      target: "pino-pretty",
      options: {
        colorize: true,
        translateTime: "HH:MM:ss",
        ignore: "pid,hostname",
      },
    }
  : undefined;

export const logger: Logger = pino({
  name: "blueberry",
  level,
  ...(transport ? { transport } : {}),
});

export const createLogger = (module: string): Logger =>
  logger.child({ module });
