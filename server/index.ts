import { buildApp } from "./app.js";

try {
  process.loadEnvFile();
} catch {
  // No .env file present; rely on process.env
}

async function main(): Promise<void> {
  const app = await buildApp();

  const host = app.config.HOST;
  const port = Number.parseInt(app.config.PORT, 10);

  try {
    await app.listen({ host, port });
    app.log.info({ host, port }, "server listening");
  } catch (err) {
    app.log.error(err);
    process.exit(1);
  }

  const shutdown = async (signal: string): Promise<void> => {
    app.log.info({ signal }, "shutting down");
    await app.close();
    process.exit(0);
  };

  process.on("SIGINT", () => {
    void shutdown("SIGINT");
  });
  process.on("SIGTERM", () => {
    void shutdown("SIGTERM");
  });
}

void main();
