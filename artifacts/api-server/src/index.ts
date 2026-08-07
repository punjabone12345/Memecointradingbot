import http from 'http';
import app from './app.js';
import { initDB } from './lib/db.js';
import { initWebSocket } from './websocket/server.js';
import { startTrenchesScanner, setOnGraduation } from './services/trenches.service.js';
// Discovery is now DexScreener token-profiles based — no on-chain imports needed
import { startSniperEngine, addGraduatedToken } from './services/sniper-engine.service.js';
import { startTelegramCommands, stopTelegramCommands } from './lib/telegram-commands.js';
import { initSessionManager } from './lib/session-manager.js';
import { logger } from './lib/logger.js';

const PORT = parseInt(process.env.PORT || '8080', 10);

/**
 * Wraps server.listen in a promise so we can await the result and exit
 * immediately if the port is already in use — BEFORE starting any services.
 *
 * Without this guard, the uncaughtException handler keeps the process alive
 * even on EADDRINUSE, running a duplicate copy of the sniper engine / GMGN
 * wallet scoring with its own independent rate-limiter state. Two processes
 * each firing GMGN requests independently doubles the request rate, causing
 * rate-limit bans even with a conservative per-key interval.
 */
function bindServer(server: http.Server, port: number): Promise<void> {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '0.0.0.0', () => {
      server.removeListener('error', reject); // don't intercept post-startup errors
      resolve();
    });
  });
}

async function main(): Promise<void> {
  await initDB();

  const server = http.createServer(app);
  initWebSocket(server);

  // Bind the port FIRST — if another instance already owns it, throw here
  // so main() rejects and we exit before any services are started.
  await bindServer(server, PORT);
  logger.info({ port: PORT }, 'Apex Meme Trader API running');

  // Re-attach a post-startup error handler for unexpected runtime errors
  // (NOT EADDRINUSE — that was handled above).
  server.on('error', (err) => {
    logger.error({ err }, 'HTTP server runtime error');
  });

  // Wire GMGN token discovery → sniper engine
  setOnGraduation(addGraduatedToken);
  startTrenchesScanner();
  await startSniperEngine();
  startTelegramCommands();

  // Session manager: honours the persisted botEnabled flag — stops all services
  // immediately if the bot was saved as disabled, and handles future toggles.
  await initSessionManager();

  process.on('SIGTERM', () => {
    logger.info('SIGTERM received, shutting down');
    stopTelegramCommands();
    server.close(() => process.exit(0));
  });
}

// Keep the process alive — log but never crash on unhandled errors.
// Without these handlers, a single unhandled rejection (e.g. a flaky RPC call
// escaping try/catch) can silently kill the server and stop all trading.
//
// Exception: EADDRINUSE means another instance already owns the port. Exit
// immediately so no duplicate sniper engine / GMGN wallet scoring runs.
// The bindServer() await also catches this via main().catch(), but some Node
// versions route it through uncaughtException first — this guard ensures exit
// regardless of which path the error takes.
process.on('uncaughtException', (err: NodeJS.ErrnoException) => {
  if (err.code === 'EADDRINUSE') {
    logger.error(
      { port: PORT },
      'Port already in use — exiting to prevent duplicate services (GMGN/Helius double-rate)',
    );
    process.exit(1);
  }
  logger.error({ err }, 'Uncaught exception — process kept alive');
});
process.on('unhandledRejection', (reason) => {
  logger.error({ reason: String(reason) }, 'Unhandled promise rejection — process kept alive');
});

main().catch((err: NodeJS.ErrnoException) => {
  if (err.code === 'EADDRINUSE') {
    logger.error(
      { port: PORT },
      'Port already in use — another API server instance is running. ' +
      'Exiting to prevent duplicate sniper engine / GMGN wallet scoring processes ' +
      'that would double the GMGN request rate and cause rate-limit bans.',
    );
    process.exit(1);
  }
  logger.error({ err }, 'Fatal startup error');
  process.exit(1);
});
