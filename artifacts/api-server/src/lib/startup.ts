/**
 * Server session start timestamp.
 * Captured once at module import time — resets to the current ms on every
 * server restart.  Used to scope all DB-backed diagnostic queries to the
 * current session so stats always start at zero on restart.
 */
export const SESSION_START_MS: number = Date.now();
