import axios from 'axios';
import { logger } from './logger.js';
import { getSniperStatus } from '../services/sniper-engine.service.js';
import { getBalance } from '../services/settings.service.js';

const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const CHAT_ID = process.env.TELEGRAM_CHAT_ID;

const BASE_URL = () => `https://api.telegram.org/bot${BOT_TOKEN}`;

let updateOffset = 0;
let pollTimeout: ReturnType<typeof setTimeout> | null = null;
let _telegramRunning = false;
const startedAt = Date.now();

function toIST(date: Date): string {
  return date.toLocaleString('en-IN', { timeZone: 'Asia/Kolkata', hour12: false });
}

async function sendReply(chatId: number | string, text: string): Promise<void> {
  try {
    await axios.post(`${BASE_URL()}/sendMessage`, {
      chat_id: chatId,
      text,
      parse_mode: 'HTML',
    });
  } catch (err) {
    logger.warn({ err }, 'Telegram command reply failed');
  }
}

// ── /command1 — Check your open sniper positions ──────────────────────────────────
async function handlePositions(chatId: number | string): Promise<void> {
  const status = getSniperStatus();
  const balance = await getBalance();
  const positions = status.openPositions;

  if (positions.length === 0) {
    await sendReply(chatId,
      `📭 <b>No Open Sniper Positions</b>\n` +
      `Balance: ${balance.toFixed(3)} SOL\n` +
      `Tracking ${status.stats.tracking} token(s)\n` +
      `Time: ${toIST(new Date())}`
    );
    return;
  }

  const lines: string[] = [
    `🎯 <b>Open Sniper Positions (${positions.length})</b>`,
    `Balance: ${balance.toFixed(3)} SOL\n`,
  ];

  for (const pos of positions) {
    const pnlSol = pos.initialSizeSol * (pos.pnlPct / 100);
    const pnlEmoji = pos.pnlPct >= 0 ? '🟢' : '🔴';
    const tpHits = [pos.tp1Hit && 'TP1', pos.tp2Hit && 'TP2', pos.tp3Hit && 'TP3']
      .filter(Boolean).join(' ') || '—';
    lines.push(
      `${pnlEmoji} <b>${pos.symbol}</b> (${pos.name}) · Tier ${pos.tpTier}\n` +
      `  Entry: $${pos.entryPrice.toFixed(8)}\n` +
      `  Now:   $${pos.lastPrice.toFixed(8)}\n` +
      `  Size: ${pos.initialSizeSol.toFixed(3)} SOL (remaining ${pos.remainingSizeSol.toFixed(3)})\n` +
      `  PNL: ${pos.pnlPct >= 0 ? '+' : ''}${pos.pnlPct.toFixed(1)}% / ${pnlSol >= 0 ? '+' : ''}${pnlSol.toFixed(4)} SOL\n` +
      `  TPs hit: ${tpHits}`
    );
  }

  lines.push(`\n🕐 ${toIST(new Date())}`);
  await sendReply(chatId, lines.join('\n'));
}

// ── /command2 — Analyse Sniper Engine ────────────────────────────────────────
async function handleAnalyse(chatId: number | string): Promise<void> {
  const status = getSniperStatus();
  const closed = status.closedPositions;
  const wins = closed.filter((p) => p.closePnlPct > 0).length;
  const winRate = closed.length > 0 ? (wins / closed.length) * 100 : 0;
  const totalPnlSol = closed.reduce((s, p) => s + p.initialSizeSol * (p.closePnlPct / 100), 0);

  const todayStr = new Date().toDateString();
  const dailyPnl = closed
    .filter((p) => new Date(p.closeTime).toDateString() === todayStr)
    .reduce((s, p) => s + p.initialSizeSol * (p.closePnlPct / 100), 0);

  const text =
    `🎯 <b>Sniper Engine Analysis</b>\n\n` +

    `<b>📈 Performance</b>\n` +
    `Closed trades: ${closed.length}\n` +
    `Win Rate: ${winRate.toFixed(1)}%\n` +
    `Total PNL: ${totalPnlSol >= 0 ? '+' : ''}${totalPnlSol.toFixed(4)} SOL\n` +
    `Today PNL: ${dailyPnl >= 0 ? '+' : ''}${dailyPnl.toFixed(4)} SOL\n\n` +

    `<b>🔍 Discovery</b>\n` +
    `Tracking: ${status.stats.tracking} tokens\n` +
    `Pending graduations: ${status.stats.pending}\n` +
    `Queued signals: ${status.stats.queued}\n` +
    `Open positions: ${status.stats.positions} / 10\n\n` +

    `🕐 ${toIST(new Date())}`;

  await sendReply(chatId, text);
}

// ── /command3 — Check the bot working or not ────────────────────────────────
async function handleStatus(chatId: number | string): Promise<void> {
  const status = getSniperStatus();
  const balance = await getBalance();

  const uptimeSec = Math.floor((Date.now() - startedAt) / 1000);
  const uptimeStr = uptimeSec < 60
    ? `${uptimeSec}s`
    : uptimeSec < 3600
    ? `${Math.floor(uptimeSec / 60)}m ${uptimeSec % 60}s`
    : `${Math.floor(uptimeSec / 3600)}h ${Math.floor((uptimeSec % 3600) / 60)}m`;

  const text =
    `✅ <b>Bot Status — ONLINE</b>\n\n` +
    `Uptime: ${uptimeStr}\n` +
    `Sniper Engine: 🟢 Active (tracking ${status.stats.tracking} tokens)\n` +
    `Open positions: ${status.stats.positions}\n` +
    `Balance: ${balance.toFixed(3)} SOL\n\n` +
    `🕐 ${toIST(new Date())}`;

  await sendReply(chatId, text);
}

// ── Update dispatcher ────────────────────────────────────────────────────────
interface TelegramUpdate {
  update_id: number;
  message?: {
    chat: { id: number };
    from?: { id: number };
    text?: string;
  };
}

async function processUpdate(update: TelegramUpdate): Promise<void> {
  const msg = update.message;
  if (!msg?.text) return;

  const chatId = msg.chat.id;
  const text = msg.text.trim();
  const cmd = text.split(' ')[0].toLowerCase();

  // Security: only respond to the configured chat
  if (CHAT_ID && String(chatId) !== String(CHAT_ID)) {
    logger.warn({ chatId }, 'Telegram command from unknown chat — ignored');
    return;
  }

  logger.info({ cmd, chatId }, 'Telegram command received');

  try {
    if (cmd === '/command1' || cmd === '/positions') {
      await handlePositions(chatId);
    } else if (cmd === '/command2' || cmd === '/analyse' || cmd === '/analyze') {
      await handleAnalyse(chatId);
    } else if (cmd === '/command3' || cmd === '/status') {
      await handleStatus(chatId);
    } else if (cmd === '/start' || cmd === '/help') {
      await sendReply(chatId,
        `👋 <b>Apex Meme Trader Bot</b>\n\n` +
        `/command1 — Check your open sniper positions\n` +
        `/command2 — Analyse Sniper Engine\n` +
        `/command3 — Check the bot working or not`
      );
    }
  } catch (err) {
    logger.warn({ err, cmd }, 'Telegram command handler error');
    await sendReply(chatId, '⚠️ Error processing command. The bot is still running.');
  }
}

// ── Long-poll loop ───────────────────────────────────────────────────────────
async function pollOnce(): Promise<void> {
  try {
    const res = await axios.get<{ ok: boolean; result: TelegramUpdate[] }>(
      `${BASE_URL()}/getUpdates`,
      {
        params: { offset: updateOffset, timeout: 25, allowed_updates: ['message'] },
        timeout: 30_000,
      }
    );

    if (res.data.ok) {
      for (const update of res.data.result) {
        await processUpdate(update);
        updateOffset = update.update_id + 1;
      }
    }
  } catch (err) {
    const axErr = err as { code?: string; response?: { status?: number } };
    if (axErr.code !== 'ECONNABORTED' && axErr.response?.status !== 409) {
      logger.warn({ err }, 'Telegram poll error');
    }
  }
}

async function pollLoop(): Promise<void> {
  if (!_telegramRunning) return; // guard: stop requested before this iteration
  await pollOnce();
  if (!_telegramRunning) return; // guard: stop requested while pollOnce was in flight
  pollTimeout = setTimeout(() => { void pollLoop(); }, 100);
}

export function startTelegramCommands(): void {
  if (!BOT_TOKEN) {
    logger.info('TELEGRAM_BOT_TOKEN not set — command polling disabled');
    return;
  }
  if (_telegramRunning) return; // idempotent — already started
  _telegramRunning = true;

  // Drop any pending updates that accumulated while the bot was offline
  // by fetching with offset=-1 and a zero timeout on startup.
  axios.get(`${BASE_URL()}/getUpdates`, {
    params: { offset: -1, timeout: 0 },
    timeout: 5_000,
  }).then((res: { data: { result?: TelegramUpdate[] } }) => {
    if (!_telegramRunning) return; // stop was called before startup completed
    const updates = res.data?.result ?? [];
    if (updates.length > 0) {
      updateOffset = updates[updates.length - 1].update_id + 1;
    }
    void pollLoop();
  }).catch(() => {
    if (_telegramRunning) void pollLoop();
  });

  logger.info('Telegram command polling started (/command1 /command2 /command3)');
}

export function stopTelegramCommands(): void {
  _telegramRunning = false;
  if (pollTimeout) {
    clearTimeout(pollTimeout);
    pollTimeout = null;
  }
  logger.info('Telegram command polling stopped');
}
