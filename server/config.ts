export const envSchema = {
  type: "object",
  required: ["HOST", "PORT", "LOG_LEVEL", "ORIGINS", "DATABASE_PATH"],
  properties: {
    HOST: { type: "string", default: "127.0.0.1" },
    PORT: { type: "string", default: "8787" },
    LOG_LEVEL: { type: "string", default: "info" },
    ORIGINS: { type: "string", default: "http://localhost:5173" },
    DATABASE_PATH: { type: "string", default: "./data/orbit.db" },
  },
} as const;

export interface EnvConfig {
  HOST: string;
  PORT: string;
  LOG_LEVEL: string;
  ORIGINS: string;
  DATABASE_PATH: string;
}
