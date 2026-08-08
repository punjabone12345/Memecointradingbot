export interface Settings {
  // Master on/off switch — when false ALL background services stop completely
  botEnabled: boolean;
  // Paper
  startingBalanceSol: number;
  currentBalanceSol: number;
  // Live
  rpcEndpoint: string;
  slippagePct: number;
  priorityFeeSol: number;
  walletPublicKey: string;
  sniperSlippagePct: number;
  sniperStagnationPct: number;  // exit if |priceChange1h| < this %, after 1h open
  // Trading window (IST)
  tradingWindowEnabled: boolean;
  tradingWindowStart: string;  // HH:MM in IST, e.g. "17:00"
  tradingWindowEnd: string;    // HH:MM in IST, e.g. "00:00" means midnight (end of day)
  // Sniper TP tier configs ($500-$999 / $1000-$1999 / $2000+)
  wt1Tp1Pct: number;  wt1Tp1Exit: number;
  wt1Tp2Pct: number;  wt1Tp2Exit: number;  wt1Tp2Trail: number;
  wt1Tp3Pct: number;  wt1Tp3Exit: number;  wt1Tp3Trail: number;
  wt2Tp1Pct: number;  wt2Tp1Exit: number;
  wt2Tp2Pct: number;  wt2Tp2Exit: number;  wt2Tp2Trail: number;
  wt2Tp3Pct: number;  wt2Tp3Exit: number;  wt2Tp3Trail: number;
  wt3Tp1Pct: number;  wt3Tp1Exit: number;
  wt3Tp2Pct: number;  wt3Tp2Exit: number;  wt3Tp2Trail: number;
  wt3Tp3Pct: number;  wt3Tp3Exit: number;  wt3Tp3Trail: number;
}

export interface WSMessage {
  type: 'sniper_status' | 'balance' | 'alert' | 'settings';
  data: unknown;
}
