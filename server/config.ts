export const envSchema = {
  type: "object",
  required: ["HOST", "PORT", "LOG_LEVEL", "ORIGINS", "DATABASE_PATH"],
  properties: {
    HOST: { type: "string", default: "127.0.0.1" },
    PORT: { type: "string", default: "8787" },
    LOG_LEVEL: { type: "string", default: "info" },
    ORIGINS: { type: "string", default: "http://localhost:5173" },
    DATABASE_PATH: { type: "string", default: "./data/orbit.db" },

    /* Shared Moment AI (optional — absent keys keep the deterministic path) */
    AI_PROVIDER: { type: "string", default: "none" },
    AI_MODEL: { type: "string", default: "" },
    AI_API_KEY: { type: "string", default: "" },
    AI_BASE_URL: { type: "string", default: "https://api.openai.com/v1" },

    /* Watch metadata (TMDB, optional). The key lives ONLY here, server-side:
       it never reaches the browser bundle or any client payload. Without it
       the watch APIs answer "unconfigured" and the UI says search is
       unavailable — no fabricated results. */
    TMDB_API_KEY: { type: "string", default: "" },
    TMDB_BASE_URL: { type: "string", default: "https://api.themoviedb.org/3" },
    TMDB_IMAGE_URL: { type: "string", default: "https://image.tmdb.org/t/p" },
  },
} as const;

export interface EnvConfig {
  HOST: string;
  PORT: string;
  LOG_LEVEL: string;
  ORIGINS: string;
  DATABASE_PATH: string;
  AI_PROVIDER: string;
  AI_MODEL: string;
  AI_API_KEY: string;
  AI_BASE_URL: string;
  TMDB_API_KEY: string;
  TMDB_BASE_URL: string;
  TMDB_IMAGE_URL: string;
}
