import pino, { type LevelWithSilent, type Logger } from "pino";
import type { Environment } from "../../config/environment.js";

export function createLogger(environment: Environment): Logger {
  return pino({
    level: environment.logLevel as LevelWithSilent,
    base: null,
    redact: ["req.headers.authorization", "req.headers.cookie", "token", "secret", "payload"],
  });
}
