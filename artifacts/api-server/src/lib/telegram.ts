import axios from 'axios';
import { logger } from './logger.js';

const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const CHAT_ID = process.env.TELEGRAM_CHAT_ID;

function toIST(date: Date): string {
  return date.toLocaleString('en-IN', { timeZone: 'Asia/Kolkata', hour12: false });
}

async function sendMessage(text: string): Promise<void> {
  if (!BOT_TOKEN || !CHAT_ID) return;
  try {
    await axios.post(`https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`, {
      chat_id: CHAT_ID,
      text,
      parse_mode: 'HTML',
    });
  } catch (err) {
    logger.warn({ err }, 'Telegram send failed');
  }
}

export async function notifyBought(params: {
  name: string; symbol: string; price: number; mc: number; score: number; sizeSol: number;
}): Promise<void> {
  const { name, symbol, price, mc, score, sizeSol } = params;
  await sendMessage(
    `🟢 <b>BOUGHT ${symbol}</b> (${name})\n` +
    `Price: $${price.toFixed(8)}\n` +
    `MC: $${(mc / 1000).toFixed(0)}K\n` +
    `Score: ${score}/100\n` +
    `Size: ${sizeSol.toFixed(3)} SOL\n` +
    `Time: ${toIST(new Date())}`
  );
}

export async function notifyTPHit(params: {
  name: string; symbol: string; level: number; gainPct: number; profitSol: number; newSLPct: number;
  entryPrice: number; currentPrice: number; soldSol: number; remainingSol: number; initialSol: number;
  peakPrice: number;
}): Promise<void> {
  const { name, symbol, level, gainPct, profitSol, newSLPct, entryPrice, currentPrice, soldSol, remainingSol, initialSol, peakPrice } = params;
  // newSLPct == 0 → breakeven; newSLPct < 0 → trailing (|newSLPct|% below peak)
  let slLine: string;
  if (newSLPct === 0) {
    slLine = `New SL: $${entryPrice.toFixed(8)} (breakeven)`;
  } else {
    const trailPct = Math.abs(newSLPct);
    const trailPrice = peakPrice * (1 - trailPct / 100);
    slLine = `New SL: $${trailPrice.toFixed(8)} (${trailPct}% below peak $${peakPrice.toFixed(8)})`;
  }
  await sendMessage(
    `🎯 <b>TP${level} HIT — ${symbol}</b> (${name})\n` +
    `Gain: +${gainPct.toFixed(1)}%\n` +
    `Entry: $${entryPrice.toFixed(8)}  →  Now: $${currentPrice.toFixed(8)}\n` +
    `Sold: ${soldSol.toFixed(4)} SOL  (+${profitSol.toFixed(4)} SOL profit)\n` +
    `Remaining: ${remainingSol.toFixed(4)} SOL (of ${initialSol.toFixed(4)} SOL)\n` +
    `${slLine}\n` +
    `Time: ${toIST(new Date())}`
  );
}

export async function notifyClosed(params: {
  name: string; symbol: string; pnlSol: number; pnlPct: number; reason: string;
}): Promise<void> {
  const { name, symbol, pnlSol, pnlPct, reason } = params;
  const emoji = pnlSol >= 0 ? '🟢' : '🔴';
  await sendMessage(
    `${emoji} <b>CLOSED ${symbol}</b> (${name})\n` +
    `PNL: ${pnlSol >= 0 ? '+' : ''}${pnlSol.toFixed(4)} SOL (${pnlPct >= 0 ? '+' : ''}${pnlPct.toFixed(1)}%)\n` +
    `Reason: ${reason}\n` +
    `Time: ${toIST(new Date())}`
  );
}

export async function notifyEmergencyExit(params: {
  name: string; symbol: string; reason: string; pnlSol: number;
}): Promise<void> {
  const { name, symbol, reason, pnlSol } = params;
  await sendMessage(
    `⚠️ <b>EMERGENCY EXIT — ${symbol}</b> (${name})\n` +
    `Reason: ${reason}\n` +
    `PNL: ${pnlSol >= 0 ? '+' : ''}${pnlSol.toFixed(4)} SOL\n` +
    `Time: ${toIST(new Date())}`
  );
}

export async function notifyDailySummary(params: {
  trades: number; winRate: number; pnlSol: number;
}): Promise<void> {
  const { trades, winRate, pnlSol } = params;
  await sendMessage(
    `📊 <b>Daily Summary</b>\n` +
    `Trades: ${trades}\n` +
    `Win Rate: ${winRate.toFixed(1)}%\n` +
    `PNL: ${pnlSol >= 0 ? '+' : ''}${pnlSol.toFixed(4)} SOL\n` +
    `Time: ${toIST(new Date())}`
  );
}

export async function notifyHeartbeat(params: {
  openPositions: number; balance: number;
}): Promise<void> {
  const { openPositions, balance } = params;
  await sendMessage(
    `💓 <b>Heartbeat</b>\n` +
    `Open Positions: ${openPositions}\n` +
    `Balance: ${balance.toFixed(3)} SOL\n` +
    `Time: ${toIST(new Date())}`
  );
}

export async function notifySniperTrade(params: {
  name: string; symbol: string; mint: string;
  buyAmountUsd: number; sizePct: number; sizeSol: number;
  entryPrice: number; priceAtBuyDetection: number; slippagePct: number;
  buyerWallet?: string;
  qualifyingWallets?: string[];
  entryMode?: 'solo' | 'consensus'; entryScore?: number; qualifyingWalletsCount?: number;
  priceSource?: 'vault' | 'pool-account' | 'jupiter'; tpTier?: 1 | 2 | 3;
}): Promise<void> {
  const {
    name, symbol, mint, buyAmountUsd, sizePct, sizeSol, entryPrice, priceAtBuyDetection, slippagePct, buyerWallet,
    qualifyingWallets, entryMode, entryScore, qualifyingWalletsCount, priceSource, tpTier,
  } = params;
  const actualSlip = priceAtBuyDetection > 0
    ? ((entryPrice - priceAtBuyDetection) / priceAtBuyDetection * 100).toFixed(1)
    : '0.0';

  // For consensus mode: show ALL qualifying wallet addresses; for solo: show the single buyer wallet
  let walletLine = '';
  if (entryMode === 'consensus' && qualifyingWallets && qualifyingWallets.length > 0) {
    walletLine = qualifyingWallets
      .map((w, i) => `Wallet ${i + 1}: <code>${w}</code>`)
      .join('\n') + '\n';
  } else if (buyerWallet && buyerWallet !== 'unknown') {
    walletLine = `Buyer Wallet: <code>${buyerWallet}</code>\n`;
  }

  const modeLine = entryMode === 'consensus'
    ? `✅ Entry Mode: Consensus (${qualifyingWalletsCount ?? '?'} wallets ≥80, top score ${entryScore ?? '?'})\n`
    : `✅ Entry Mode: Solo conviction (score ${entryScore ?? '?'} ≥ 95)\n`;
  const sourceLabel = priceSource === 'vault' ? 'On-chain vault read'
    : priceSource === 'pool-account' ? 'On-chain pool reserves'
    : priceSource === 'jupiter' ? 'Jupiter quote'
    : 'Unknown';
  await sendMessage(
    `🎯 <b>ENTRY CHECKLIST — ${symbol}</b> (${name})\n` +
    `Mint: <code>${mint.slice(0, 16)}…</code>\n` +
    walletLine +
    `✅ Wallet Score Gate: passed\n` +
    modeLine +
    `✅ Price Source: ${sourceLabel}\n` +
    `✅ Slippage: ${actualSlip}% (max ${slippagePct}%)\n` +
    `✅ Position Size: ${sizePct.toFixed(2)}% (Tier ${tpTier ?? '?'})\n` +
    `Buyer Activity: ${buyAmountUsd.toFixed(0)}\n` +
    `Size: ${sizeSol.toFixed(3)} SOL\n` +
    `Entry Price: ${entryPrice.toFixed(8)}\n` +
    `Detected Price: ${priceAtBuyDetection.toFixed(8)}\n` +
    `Time: ${toIST(new Date())}`
  );
}

export async function notifySniperClose(params: {
  name: string; symbol: string; mint: string;
  pnlPct: number; pnlSol: number; reason: string;
  entryPrice: number; exitPrice: number; sizeSol: number;
}): Promise<void> {
  const { name, symbol, mint, pnlPct, pnlSol, reason, entryPrice, exitPrice, sizeSol } = params;
  const emoji = pnlPct >= 0 ? '🟢' : '🔴';
  await sendMessage(
    `${emoji} <b>WHALE CLOSE — ${symbol}</b> (${name})\n` +
    `Mint: <code>${mint.slice(0, 16)}…</code>\n` +
    `PNL: ${pnlPct >= 0 ? '+' : ''}${pnlPct.toFixed(1)}%  (${pnlSol >= 0 ? '+' : ''}${pnlSol.toFixed(4)} SOL)\n` +
    `Entry: ${entryPrice.toFixed(8)}  →  Exit: ${exitPrice.toFixed(8)}\n` +
    `Size: ${sizeSol.toFixed(3)} SOL\n` +
    `Reason: ${reason}\n` +
    `Time: ${toIST(new Date())}`
  );
}

export async function notifySniperTP(params: {
  name: string; symbol: string; mint: string;
  tpNum: 1 | 2 | 3; gainPct: number;
  chunkSol: number; returnedSol: number;
  remainingSizeSol: number; initialSizeSol: number;
  newSLPrice: number; newSLDesc: string;
  entryPrice: number; currentPrice: number;
  totalBanked: number;
}): Promise<void> {
  const { name, symbol, mint, tpNum, gainPct, chunkSol, returnedSol,
          remainingSizeSol, initialSizeSol, newSLPrice, newSLDesc,
          entryPrice, currentPrice, totalBanked } = params;
  const profitSol = returnedSol - chunkSol;
  const pctRemaining = initialSizeSol > 0 ? ((remainingSizeSol / initialSizeSol) * 100).toFixed(0) : '?';
  await sendMessage(
    `🎯 <b>WHALE TP${tpNum} — ${symbol}</b> (${name})\n` +
    `Mint: <code>${mint.slice(0, 16)}…</code>\n` +
    `Gain: +${gainPct.toFixed(1)}%  (Entry ${entryPrice.toFixed(8)} → ${currentPrice.toFixed(8)})\n` +
    `Sold: ${chunkSol.toFixed(4)} SOL → ${returnedSol.toFixed(4)} SOL (+${profitSol.toFixed(4)} profit)\n` +
    `Remaining: ${pctRemaining}% of position (${remainingSizeSol.toFixed(4)} SOL)\n` +
    `Total banked: ${totalBanked.toFixed(4)} SOL\n` +
    `New SL: ${newSLPrice.toFixed(8)} (${newSLDesc})\n` +
    `Time: ${toIST(new Date())}`
  );
}

export async function notifySniperSkip(params: {
  name: string; symbol: string; mint: string;
  buyAmountUsd: number; reason: string;
  entryPrice?: number; priceAtBuyDetection?: number; maxSlippagePct?: number;
}): Promise<void> {
  const { name, symbol, mint, buyAmountUsd, reason, entryPrice, priceAtBuyDetection, maxSlippagePct } = params;
  let extra = '';
  if (entryPrice && priceAtBuyDetection && maxSlippagePct) {
    const slip = ((entryPrice - priceAtBuyDetection) / priceAtBuyDetection * 100).toFixed(1);
    extra = `\nPrice Slip: ${slip}% (max ${maxSlippagePct}%)\nDetected Price: $${priceAtBuyDetection.toFixed(8)}\nCurrent: $${entryPrice.toFixed(8)}`;
  }
  await sendMessage(
    `⏭️ <b>WHALE SKIP — ${symbol}</b> (${name})\n` +
    `Mint: <code>${mint.slice(0, 16)}…</code>\n` +
    `Buyer Activity: $${buyAmountUsd.toFixed(0)}\n` +
    `Skip Reason: ${reason}${extra}\n` +
    `Time: ${toIST(new Date())}`
  );
}
