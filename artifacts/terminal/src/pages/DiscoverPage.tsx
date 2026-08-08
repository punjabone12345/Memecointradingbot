import { useState, useEffect } from 'react';
import { SniperStatus, TrackedToken, BuyerActivityLog, PendingSignal, DiagTransaction } from '../lib/types.js';
import { api } from '../lib/api.js';

// ── Props ─────────────────────────────────────────────────────────────────────

interface Props {
  sniperStatus?: SniperStatus | null;
  wsConnected?: boolean;
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function timeAgo(ts: number): string {
  const s = Math.floor((Date.now() - ts) / 1000);
  if (s < 60) return `${s}s ago`;
  return `${Math.floor(s / 60)}m ago`;
}

function countdown(expiresAt: number): string {
  const ms = expiresAt - Date.now();
  if (ms <= 0) return 'expired';
  const s = Math.floor(ms / 1000);
  const m = Math.floor(s / 60);
  const ss = s % 60;
  return `${m}:${ss.toString().padStart(2, '0')}`;
}

function countdownPct(migrationTime: number, expiresAt: number): number {
  const total   = expiresAt - migrationTime;
  const elapsed = Date.now() - migrationTime;
  return Math.min(100, Math.max(0, (elapsed / total) * 100));
}

function fmtUsd(n: number): string {
  if (n >= 1000) return `$${(n / 1000).toFixed(1)}k`;
  return `$${n.toFixed(0)}`;
}

function shortAddr(addr: string): string {
  return addr.slice(0, 4) + '…' + addr.slice(-4);
}

function fmtCompact(n?: number): string {
  if (!n) return '—';
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(2)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
  return `${n.toFixed(2)}`;
}

function fmtPrice(p?: number): string {
  if (!p) return '—';
  if (p < 0.000001) return `${p.toExponential(2)}`;
  if (p < 0.01) return `${p.toFixed(6)}`;
  if (p < 1) return `${p.toFixed(4)}`;
  return `${p.toFixed(2)}`;
}

// ── Sniper status hook ────────────────────────────────────────────────────────

function useSniperStatusFallback(skip: boolean) {
  const [status, setStatus] = useState<SniperStatus | null>(null);
  useEffect(() => {
    if (skip) return;
    let cancelled = false;
    async function poll() {
      try {
        const data = await api.getSniperStatus();
        if (!cancelled) setStatus(data);
      } catch { /* ignore */ }
    }
    poll();
    const id = setInterval(poll, 3_000);
    return () => { cancelled = true; clearInterval(id); };
  }, [skip]);
  return status;
}

// ── Discovery data types ──────────────────────────────────────────────────────

interface MigrationEvent {
  mint:             string;
  ts:               number;
  name?:            string;
  symbol?:          string;
  isMigration:      boolean;
  reserveUsd?:      number;
  discoverySource?: string;
  txSignature?:     string;
  instructionType?: string;
}

interface PumpfunTrackerData {
  total:               number;
  recent:              MigrationEvent[];
  walletAddress?:      string;
  pollCount?:          number;
  lastPollAgoSec?:     number | null;
  consecutiveFailures?: number;
  lastError?:          string | null;
  heliusApiKeySet?:    boolean;
  rpcEndpoint?:        string;
  tokensPerHour?:      number | null;
  txFetchErrorRate?:   number;
}

interface SourcesResponse {
  pumpfun?: PumpfunTrackerData;
  // legacy fallback
  gmgn?: {
    total: number;
    recent: MigrationEvent[];
    pollers?: { migrated?: { pollCount: number; lastSuccessAgoSec: number | null; consecutiveFailures: number; firedTotal?: number; intervalMs: number; lastError: string | null } };
  };
}

function useTrackerData(): { data: PumpfunTrackerData | null; loading: boolean } {
  const [data, setData] = useState<PumpfunTrackerData | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    async function poll() {
      try {
        const json = (await api.getScannerSources()) as unknown as SourcesResponse;
        if (!cancelled) {
          // Prefer new pumpfun shape; fall back to legacy gmgn
          const pf = json.pumpfun;
          const gm = json.gmgn;
          setData(pf ?? {
            total:    gm?.total ?? 0,
            recent:   gm?.recent ?? [],
            pollCount: gm?.pollers?.migrated?.pollCount,
            lastPollAgoSec: gm?.pollers?.migrated?.lastSuccessAgoSec,
            consecutiveFailures: gm?.pollers?.migrated?.consecutiveFailures,
          } as PumpfunTrackerData);
          setLoading(false);
        }
      } catch { /* ignore */ }
    }
    poll();
    const id = setInterval(poll, 2_000);
    return () => { cancelled = true; clearInterval(id); };
  }, []);

  return { data, loading };
}

// ── Design tokens ─────────────────────────────────────────────────────────────

const C = {
  card:   { background: 'rgba(255,255,255,0.03)', border: '1px solid rgba(255,255,255,0.07)', borderRadius: 12, padding: '12px 14px', marginBottom: 10 } as React.CSSProperties,
  label:  { fontSize: 9, fontWeight: 800, letterSpacing: '0.12em', color: '#3a5070' } as React.CSSProperties,
  accent: '#00bfff',
  green:  '#00ff88',
  red:    '#ff4466',
  yellow: '#ffd700',
  orange: '#ff8c00',
  gray:   '#4a6080',
  pump:   '#a855f7',  // purple brand colour for pump.fun migrations
};

function dexUrl(mint: string): string {
  return `https://dexscreener.com/solana/${mint}`;
}

function DexLink({ mint }: { mint: string }) {
  return (
    <a
      href={dexUrl(mint)}
      target="_blank"
      rel="noopener noreferrer"
      onClick={e => e.stopPropagation()}
      style={{
        display: 'inline-flex', alignItems: 'center', gap: 3,
        fontSize: 8, fontWeight: 800, letterSpacing: '0.05em',
        padding: '2px 6px', borderRadius: 4,
        background: 'rgba(255,196,0,0.08)', color: '#ffc400',
        border: '1px solid rgba(255,196,0,0.25)',
        textDecoration: 'none', cursor: 'pointer', flexShrink: 0,
      }}
    >
      ↗ DEX
    </a>
  );
}

function PumpLink({ mint }: { mint: string }) {
  return (
    <a
      href={`https://pump.fun/${mint}`}
      target="_blank"
      rel="noopener noreferrer"
      onClick={e => e.stopPropagation()}
      style={{
        display: 'inline-flex', alignItems: 'center', gap: 3,
        fontSize: 8, fontWeight: 800, letterSpacing: '0.05em',
        padding: '2px 6px', borderRadius: 4,
        background: 'rgba(168,85,247,0.10)', color: C.pump,
        border: '1px solid rgba(168,85,247,0.25)',
        textDecoration: 'none', cursor: 'pointer', flexShrink: 0,
      }}
    >
      🚀 PUMP
    </a>
  );
}

function StatPill({ label, value, color }: { label: string; value: string | number; color?: string }) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 2, minWidth: 54 }}>
      <span style={{ fontSize: 18, fontWeight: 900, color: color ?? C.accent, fontVariantNumeric: 'tabular-nums' }}>{value}</span>
      <span style={{ fontSize: 8, fontWeight: 800, letterSpacing: '0.1em', color: C.gray, textTransform: 'uppercase' }}>{label}</span>
    </div>
  );
}

function PctBadge({ value, label }: { value?: number; label: string }) {
  if (value == null) return null;
  const pos = value >= 0;
  return (
    <div style={{ textAlign: 'center' }}>
      <div style={{ fontSize: 10, fontWeight: 800, fontVariantNumeric: 'tabular-nums', color: pos ? C.green : C.red }}>
        {pos ? '+' : ''}{value.toFixed(1)}%
      </div>
      <div style={{ fontSize: 8, color: C.gray }}>{label}</div>
    </div>
  );
}

// ── TrackedCard ───────────────────────────────────────────────────────────────

function TrackedCard({ tok, tick }: { tok: TrackedToken; tick: number }) {
  void tick;
  const pct        = countdownPct(tok.migrationTime, tok.expiresAt);
  const remaining  = countdown(tok.expiresAt);
  const expired    = tok.expiresAt <= Date.now();
  const biggestBuy = tok.buyerActivity.reduce((max, b) => b.amountUsd > max ? b.amountUsd : max, 0);
  const hasMarket  = (tok.price ?? 0) > 0;

  return (
    <div style={{
      ...C.card, marginBottom: 8,
      borderColor: tok.entryTriggered ? 'rgba(0,255,136,0.25)' : biggestBuy >= 750 ? 'rgba(0,191,255,0.3)' : 'rgba(255,255,255,0.07)',
    }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start' }}>
        <div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
            <span style={{ fontSize: 13, fontWeight: 900, color: '#e0e8ff' }}>{tok.symbol}</span>
            <span style={{ fontSize: 9, color: C.gray }}>{tok.name}</span>
            {tok.entryTriggered && (
              <span style={{ fontSize: 8, fontWeight: 800, padding: '2px 6px', borderRadius: 4, background: 'rgba(0,255,136,0.12)', color: C.green, border: '1px solid rgba(0,255,136,0.3)' }}>ENTERED</span>
            )}
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginTop: 3 }}>
            <span style={{ fontSize: 9, color: C.gray, fontFamily: 'monospace' }}>{shortAddr(tok.mint)}</span>
            <DexLink mint={tok.mint} />
          </div>
        </div>
        <div style={{ textAlign: 'right' }}>
          <div style={{ fontSize: 13, fontWeight: 900, fontVariantNumeric: 'tabular-nums', color: expired ? C.red : pct > 80 ? C.yellow : '#00d4ff' }}>
            {remaining}
          </div>
          <div style={{ fontSize: 8, color: C.gray }}>remaining</div>
        </div>
      </div>

      {hasMarket ? (
        <div style={{ margin: '10px 0 6px' }}>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 6, padding: '8px 10px', borderRadius: '8px 8px 0 0', background: 'rgba(0,191,255,0.04)', border: '1px solid rgba(0,191,255,0.08)', borderBottom: 'none' }}>
            <div style={{ textAlign: 'center' }}>
              <div style={{ fontSize: 10, fontWeight: 800, color: '#e0e8ff', fontVariantNumeric: 'tabular-nums' }}>{fmtPrice(tok.price)}</div>
              <div style={{ fontSize: 8, color: C.gray }}>price</div>
            </div>
            <div style={{ textAlign: 'center' }}>
              <div style={{ fontSize: 10, fontWeight: 800, color: '#e0e8ff' }}>${fmtCompact(tok.mcap)}</div>
              <div style={{ fontSize: 8, color: C.gray }}>mcap</div>
            </div>
            <div style={{ textAlign: 'center' }}>
              <div style={{ fontSize: 10, fontWeight: 800, color: '#e0e8ff' }}>${fmtCompact(tok.liquidity)}</div>
              <div style={{ fontSize: 8, color: C.gray }}>liquidity</div>
            </div>
            <div style={{ textAlign: 'center' }}>
              <div style={{ fontSize: 10, fontWeight: 800, color: '#e0e8ff' }}>${fmtCompact(tok.volume24h ?? tok.volume1h ?? tok.volume5m)}</div>
              <div style={{ fontSize: 8, color: C.gray }}>{tok.volume24h != null ? 'vol 24h' : tok.volume1h != null ? 'vol 1h' : 'vol 5m'}</div>
            </div>
          </div>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 6, padding: '6px 10px', borderRadius: '0 0 8px 8px', background: 'rgba(0,191,255,0.02)', border: '1px solid rgba(0,191,255,0.08)' }}>
            <PctBadge value={tok.priceChange5m} label="5m chg" />
            <PctBadge value={tok.priceChange1h} label="1h chg" />
            <PctBadge value={tok.priceChange24h} label="24h chg" />
            <div style={{ textAlign: 'center' }}>
              {(tok.txnsH24Buys ?? 0) > 0 || (tok.txnsH24Sells ?? 0) > 0 ? (
                <>
                  <div style={{ fontSize: 9, fontWeight: 800, fontVariantNumeric: 'tabular-nums' }}>
                    <span style={{ color: C.green }}>{tok.txnsH24Buys ?? 0}B</span>
                    <span style={{ color: C.gray }}> / </span>
                    <span style={{ color: C.red }}>{tok.txnsH24Sells ?? 0}S</span>
                  </div>
                  <div style={{ fontSize: 8, color: C.gray }}>txns 24h</div>
                </>
              ) : (
                <>
                  <div style={{ fontSize: 9, color: C.gray }}>{tok.lastMarketUpdate ? timeAgo(tok.lastMarketUpdate) : '—'}</div>
                  <div style={{ fontSize: 8, color: C.gray }}>updated</div>
                </>
              )}
            </div>
          </div>
        </div>
      ) : (
        <div style={{ fontSize: 9, color: C.gray, margin: '8px 0 4px', fontStyle: 'italic' }}>Fetching market data…</div>
      )}

      <div style={{ margin: '6px 0 6px', height: 3, borderRadius: 2, background: 'rgba(255,255,255,0.06)', overflow: 'hidden' }}>
        <div style={{ width: `${pct}%`, height: '100%', borderRadius: 2, background: expired ? C.red : pct > 80 ? `linear-gradient(90deg,${C.yellow},${C.red})` : `linear-gradient(90deg,${C.accent},#7b5ea7)`, transition: 'width 1s linear' }} />
      </div>

      {tok.buyerActivity.length > 0 && (
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4, marginTop: 2 }}>
          {tok.buyerActivity.slice(0, 5).map((b, i) => (
            <span key={i} style={{ fontSize: 9, fontWeight: 800, padding: '2px 6px', borderRadius: 4, background: b.amountUsd >= 2250 ? 'rgba(0,191,255,0.18)' : b.amountUsd >= 1500 ? 'rgba(0,191,255,0.11)' : 'rgba(0,191,255,0.06)', color: C.accent, border: '1px solid rgba(0,191,255,0.2)' }}>
              📈 {fmtUsd(b.amountUsd)} · {timeAgo(b.detectedAt ?? b.timestamp)}
            </span>
          ))}
        </div>
      )}
      {!hasMarket && tok.buyerActivity.length === 0 && (
        <div style={{ fontSize: 9, color: C.gray }}>Monitoring wallet activity…</div>
      )}
    </div>
  );
}

function BuyerActivityRow({ entry }: { entry: BuyerActivityLog }) {
  const [expanded, setExpanded] = useState(false);
  const score = entry.walletScore;
  const scoreColor = score == null ? C.gray : score >= 95 ? C.green : score >= 80 ? C.accent : C.gray;
  const modeLabel = entry.consensusMode === 'consensus' ? 'CONSENSUS'
    : entry.consensusMode === 'tracking' ? `${entry.qualifyingWalletsCount ?? 0}/2 QUALIFYING`
    : null;
  const gmgn = entry.gmgnScore;
  const pts = gmgn?.scorePoints ?? { winRate: 0, walletAge: 0, completedTrades: 0, roi: 0, holdTime: 0 };
  const solscanWallet = `https://solscan.io/account/${entry.wallet}`;
  const solscanTx = entry.txSig ? `https://solscan.io/tx/${entry.txSig}` : null;

  return (
    <div style={{ borderBottom: '1px solid rgba(255,255,255,0.04)' }}>
      <div 
        onClick={() => setExpanded(!expanded)}
        style={{ display: 'flex', alignItems: 'flex-start', gap: 10, padding: '8px 0', cursor: 'pointer', userSelect: 'none' }}
      >
        <div style={{ flexShrink: 0, marginTop: 1, width: 34, height: 34, borderRadius: 8, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', background: `rgba(${score != null && score >= 95 ? '0,255,136' : score != null && score >= 80 ? '0,191,255' : '255,255,255'},0.1)`, border: `1px solid ${scoreColor}55` }}>
          <span style={{ fontSize: 12, fontWeight: 900, color: scoreColor, lineHeight: 1 }}>{score ?? '—'}</span>
          <span style={{ fontSize: 6, color: C.gray, lineHeight: 1 }}>GMGN</span>
        </div>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
            <span style={{ fontSize: 12, fontWeight: 900, color: C.accent }}>{fmtUsd(entry.amountUsd)}</span>
            <span style={{ fontSize: 10, color: '#e0e8ff', fontWeight: 700 }}>{entry.txType === 'sell' ? 'sell on' : 'buy on'} {entry.symbol}</span>
            <DexLink mint={entry.mint} />
            {modeLabel && (
              <span style={{ fontSize: 8, fontWeight: 800, padding: '1px 5px', borderRadius: 3, background: 'rgba(155,89,255,0.12)', color: '#9b59ff', border: '1px solid rgba(155,89,255,0.3)' }}>{modeLabel}</span>
            )}
            {entry.entered ? (
              <span style={{ fontSize: 8, fontWeight: 800, padding: '1px 5px', borderRadius: 3, background: 'rgba(0,255,136,0.12)', color: C.green, border: '1px solid rgba(0,255,136,0.25)' }}>ENTERED</span>
            ) : (
              <span style={{ fontSize: 8, padding: '1px 5px', borderRadius: 3, background: 'rgba(255,255,255,0.04)', color: C.gray }}>{entry.skipReason ?? 'skipped'}</span>
            )}
          </div>
          <div style={{ fontSize: 8, color: C.gray, marginTop: 2, display: 'flex', alignItems: 'center', gap: 6 }}>
            <span>{shortAddr(entry.wallet)} · {timeAgo(entry.detectedAt ?? entry.timestamp)}</span>
            <span style={{ color: C.accent, fontWeight: 700 }}>{expanded ? '▲ Details' : '▼ Details'}</span>
          </div>
        </div>
      </div>

      {expanded && (
        <div style={{ padding: '8px 12px 12px', marginBottom: 6, borderRadius: 8, background: 'rgba(0,0,0,0.25)', border: '1px solid rgba(255,255,255,0.06)', display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
          <div>
            <div style={{ ...C.label, marginBottom: 6 }}>Transaction Info</div>
            <div style={{ fontSize: 9, color: C.gray, lineHeight: 1.8 }}>
              <div>Type: <b style={{ color: entry.txType === 'sell' ? C.accent : C.green }}>{(entry.txType ?? 'buy').toUpperCase()}</b></div>
              <div>Amount: <b style={{ color: '#dce6f8' }}>{fmtUsd(entry.amountUsd)}</b></div>
              {entry.priceAtDetection ? <div>Price at Detection: <b style={{ color: '#dce6f8' }}>{fmtPrice(entry.priceAtDetection)}</b></div> : null}
              <div>Wallet: <a href={solscanWallet} target="_blank" rel="noopener noreferrer" style={{ color: C.accent }}>{entry.wallet}</a></div>
              {solscanTx ? <div>Signature: <a href={solscanTx} target="_blank" rel="noopener noreferrer" style={{ color: C.accent }}>{entry.txSig.slice(0, 12)}…{entry.txSig.slice(-6)}</a></div> : null}
              <div>Source: <b style={{ color: '#dce6f8' }}>{gmgn?.scoreSource ?? 'gmgn'} · {gmgn?.scoreStatus ?? 'scored'}</b></div>
            </div>
            <div style={{ marginTop: 8, padding: '6px 8px', borderRadius: 6, background: entry.entered ? 'rgba(0,255,136,0.07)' : 'rgba(255,255,255,0.03)', border: '1px solid rgba(255,255,255,0.08)' }}>
              <div style={{ ...C.label, color: entry.entered ? C.green : C.gray }}>Decision Reason</div>
              <div style={{ marginTop: 3, color: '#dce6f8', fontSize: 9, lineHeight: 1.35 }}>{entry.skipReason ?? (entry.entered ? 'Qualified for entry' : 'Skipped')}</div>
            </div>
          </div>

          <div>
            <div style={{ ...C.label, marginBottom: 6 }}>GMGN Score Calculation</div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 5 }}>
              <ScoreMetric label="Win rate (>60%)" value={gmgn?.winRate == null ? 'not available' : `${(Number(gmgn.winRate) * 100).toFixed(1)}%`} points={pts.winRate ?? 0} max={30} />
              <ScoreMetric label="Wallet age (>10d)" value={gmgn?.walletAgeDays == null ? 'not calculated' : `${Number(gmgn.walletAgeDays).toFixed(1)} days`} points={pts.walletAge ?? 0} max={15} />
              <ScoreMetric label="Completed trades (>=20)" value={gmgn?.completedTrades == null ? 'not available' : String(gmgn.completedTrades)} points={pts.completedTrades ?? 0} max={15} />
              <ScoreMetric label="Average ROI (>30%)" value={gmgn?.avgRoiPct == null ? 'not available' : `${Number(gmgn.avgRoiPct).toFixed(1)}%`} points={pts.roi ?? 0} max={25} />
              <ScoreMetric label="Average hold (>2m)" value={gmgn?.avgHoldMinutes == null ? 'not available' : `${Number(gmgn.avgHoldMinutes).toFixed(1)} min`} points={pts.holdTime ?? 0} max={15} />
            </div>
            <div style={{ marginTop: 8, color: C.gray, fontSize: 8, lineHeight: 1.3 }}>
              Total Score: <b style={{ color: scoreColor }}>{score ?? 0}/100</b> (≥80 required for wallet consensus).
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

function ScoreMetric({ label, value, points, max }: { label: string; value: string; points: number; max: number }) {
  return (
    <div style={{ display: 'grid', gridTemplateColumns: '92px 1fr auto', gap: 6, alignItems: 'center', fontSize: 8 }}>
      <span style={{ color: C.gray }}>{label}</span>
      <span style={{ color: '#b9c8e4', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{value}</span>
      <span style={{ color: points > 0 ? C.green : C.gray, fontWeight: 800 }}>+{points}/{max}</span>
    </div>
  );
}

function TransactionAuditRow({ tx, expanded, onToggle }: { tx: DiagTransaction; expanded: boolean; onToggle: () => void }) {
  const score = Number(tx.wallet_score ?? 0);
  const points = tx.score_points ?? {};
  const decisionColor = tx.decision === 'ENTERED' ? C.green
    : tx.decision === 'SELL_OBSERVED' ? C.accent
    : tx.decision === 'WAITING_CONSENSUS' || tx.decision === 'QUEUED' ? C.yellow
    : tx.decision === 'GMGN_RATE_LIMITED' ? C.yellow : C.red;
  const txTime = Number(tx.detected_at || tx.created_at);
  const solscanTx = `https://solscan.io/tx/${tx.tx_signature}`;
  const solscanWallet = `https://solscan.io/account/${tx.wallet}`;
  return (
    <div style={{ borderTop: '1px solid rgba(255,255,255,0.04)' }}>
      <button onClick={onToggle} style={{ width: '100%', display: 'grid', gridTemplateColumns: '58px 1fr auto', gap: 8, alignItems: 'center', textAlign: 'left', padding: '8px 0', color: '#dce6f8', background: 'transparent', border: 'none', cursor: 'pointer' }}>
        <span style={{ color: decisionColor, fontSize: 8, fontWeight: 900 }}>{tx.tx_type.toUpperCase()}<br /><span style={{ color: C.gray, fontWeight: 500 }}>{timeAgo(txTime)}</span></span>
        <span style={{ minWidth: 0 }}>
          <span style={{ display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
            <span style={{ color: '#e0e8ff', fontWeight: 800, fontSize: 10 }}>{tx.mint.slice(0, 6)}…{tx.mint.slice(-4)}</span>
            <span style={{ color: decisionColor, fontWeight: 900, fontSize: 9 }}>{tx.decision}</span>
            <span style={{ color: C.gray, fontSize: 8 }}>{tx.decision_reason}</span>
          </span>
          <span style={{ display: 'block', marginTop: 2, color: C.gray, fontSize: 8, fontFamily: 'monospace' }}>{tx.wallet.slice(0, 8)}…{tx.wallet.slice(-6)} · {tx.tx_signature.slice(0, 10)}…</span>
        </span>
        <span style={{ textAlign: 'right', whiteSpace: 'nowrap' }}>
          <span style={{ display: 'block', color: score >= 80 ? C.green : score > 0 ? C.yellow : C.gray, fontSize: 14, fontWeight: 900 }}>{score}</span>
          <span style={{ color: C.gray, fontSize: 7 }}>GMGN /100</span>
        </span>
      </button>
      {expanded && (
        <div style={{ padding: '6px 10px 12px', marginBottom: 4, borderRadius: 7, background: 'rgba(0,0,0,0.16)', display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
          <div>
            <div style={{ ...C.label, marginBottom: 6 }}>Transaction Detail</div>
            <div style={{ fontSize: 9, color: C.gray, lineHeight: 1.8 }}>
              <div>Amount: <b style={{ color: '#dce6f8' }}>{fmtUsd(Number(tx.amount_usd ?? 0))}</b></div>
              <div>Price: <b style={{ color: '#dce6f8' }}>{fmtPrice(Number(tx.price_at_detection ?? 0))}</b></div>
              <div>Wallet: <a href={solscanWallet} target="_blank" rel="noopener noreferrer" style={{ color: C.accent }}>{tx.wallet}</a></div>
              <div>Signature: <a href={solscanTx} target="_blank" rel="noopener noreferrer" style={{ color: C.accent }}>{tx.tx_signature}</a></div>
              <div>Source: <b style={{ color: '#dce6f8' }}>{tx.score_source} · {tx.score_status}</b></div>
            </div>
            <div style={{ marginTop: 8, padding: '7px 8px', borderRadius: 5, background: tx.decision === 'ENTERED' ? 'rgba(0,255,136,0.07)' : 'rgba(255,68,102,0.07)', border: `1px solid ${decisionColor}33` }}>
              <div style={{ ...C.label, color: decisionColor }}>Decision Explanation</div>
              <div style={{ marginTop: 3, color: '#dce6f8', fontSize: 9, lineHeight: 1.35 }}>{tx.decision_reason}</div>
            </div>
          </div>
          <div>
            <div style={{ ...C.label, marginBottom: 6 }}>GMGN Score Calculation</div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 5 }}>
              <ScoreMetric label="Win rate" value={tx.win_rate == null ? 'not available' : `${(Number(tx.win_rate) * 100).toFixed(1)}%`} points={Number(points.winRate ?? 0)} max={30} />
              <ScoreMetric label="Wallet age" value={tx.wallet_age_days == null ? 'not queried' : `${Number(tx.wallet_age_days).toFixed(1)} days`} points={Number(points.walletAge ?? 0)} max={15} />
              <ScoreMetric label="Completed trades" value={tx.completed_trades == null ? 'not available' : String(tx.completed_trades)} points={Number(points.completedTrades ?? 0)} max={15} />
              <ScoreMetric label="Average ROI" value={tx.avg_roi_pct == null ? 'not available' : `${Number(tx.avg_roi_pct).toFixed(1)}%`} points={Number(points.roi ?? 0)} max={25} />
              <ScoreMetric label="Average hold" value={tx.avg_hold_minutes == null ? 'not available' : `${Number(tx.avg_hold_minutes).toFixed(1)} min`} points={Number(points.holdTime ?? 0)} max={15} />
            </div>
            <div style={{ marginTop: 7, color: C.gray, fontSize: 8 }}>Threshold: score ≥80 qualifies; two distinct qualifying wallets within 5 minutes are required for consensus.</div>
          </div>
        </div>
      )}
    </div>
  );
}

function TransactionAuditPanel({ since }: { since?: number }) {
  const [rows, setRows] = useState<DiagTransaction[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const [expanded, setExpanded] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    const load = async () => {
      try {
        const result = await api.getDiagTransactions({ limit: 100, since });
        if (!cancelled) { setRows(result.rows); setTotal(result.total); }
      } catch { /* API may be unavailable while it restarts */ }
      finally { if (!cancelled) setLoading(false); }
    };
    load();
    const id = setInterval(load, 5_000);
    return () => { cancelled = true; clearInterval(id); };
  }, [since]);

  return (
    <div style={{ ...C.card, marginBottom: 16 }}>
      <div style={{ ...C.label, marginBottom: 2 }}>🧾 TRANSACTION AUDIT — GMGN DECISIONS</div>
      <div style={{ fontSize: 9, color: '#2a3a50', marginBottom: 8 }}>Every detected buy and sell is scored through GMGN. Expand a row for wallet, signature, rejection explanation, and point-by-point score calculation.</div>
      {loading && rows.length === 0 ? <div style={{ padding: 16, textAlign: 'center', color: C.gray, fontSize: 10 }}>Loading transaction audit…</div>
        : rows.length === 0 ? <div style={{ padding: 16, textAlign: 'center', color: C.gray, fontSize: 10 }}>No transactions audited yet</div>
        : <div>{rows.map(tx => <TransactionAuditRow key={tx.tx_signature} tx={tx} expanded={expanded === tx.tx_signature} onToggle={() => setExpanded(expanded === tx.tx_signature ? null : tx.tx_signature)} />)}</div>}
      {total > rows.length && <div style={{ paddingTop: 7, color: C.gray, fontSize: 8, textAlign: 'center' }}>Showing latest {rows.length} of {total} audited transactions</div>}
    </div>
  );
}

// ── Migration event row ───────────────────────────────────────────────────────

function MigrationRow({ ev, last }: { ev: MigrationEvent; last: boolean }) {
  const instrLabel = ev.instructionType ?? 'migrate';
  const instrColor = instrLabel === 'pool_create' || instrLabel === 'create_pool'
    ? C.orange
    : instrLabel.includes('v2')
    ? C.pump
    : '#a0b8d8';

  return (
    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '7px 0', borderBottom: last ? 'none' : '1px solid rgba(255,255,255,0.04)' }}>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 3, minWidth: 0 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 5, flexWrap: 'wrap' }}>
          <span style={{ fontSize: 8, fontWeight: 800, padding: '1px 5px', borderRadius: 3, background: 'rgba(168,85,247,0.12)', color: instrColor, border: `1px solid ${instrColor}44` }}>
            {instrLabel.toUpperCase()}
          </span>
          {ev.symbol && <span style={{ fontSize: 10, fontWeight: 800, color: '#e0e8ff' }}>{ev.symbol}</span>}
          {ev.name && <span style={{ fontSize: 8, color: C.gray }}>{ev.name.slice(0, 16)}</span>}
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 5 }}>
          <span style={{ fontSize: 8, color: '#3a5070', fontFamily: 'monospace' }}>
            {ev.mint.slice(0, 8)}…{ev.mint.slice(-5)}
          </span>
          <DexLink mint={ev.mint} />
          <PumpLink mint={ev.mint} />
        </div>
      </div>
      <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-end', gap: 2, flexShrink: 0, marginLeft: 10 }}>
        {ev.reserveUsd != null && ev.reserveUsd > 0 && (
          <span style={{ fontSize: 8, color: C.green, fontWeight: 700 }}>
            ${ev.reserveUsd >= 1000 ? (ev.reserveUsd / 1000).toFixed(1) + 'k' : ev.reserveUsd.toFixed(0)} liq
          </span>
        )}
        <span style={{ fontSize: 8, color: C.gray }}>{timeAgo(ev.ts)}</span>
      </div>
    </div>
  );
}

// ── Migration Tracker panel ───────────────────────────────────────────────────

function MigrationFeed() {
  const { data, loading } = useTrackerData();

  const total              = data?.total ?? 0;
  const events             = data?.recent ?? [];
  const pollCount          = data?.pollCount ?? 0;
  const lastAgoSec         = data?.lastPollAgoSec;
  const failures           = data?.consecutiveFailures ?? 0;
  const lastError          = data?.lastError ?? null;
  const heliusSet          = data?.heliusApiKeySet ?? false;
  const rpc                = data?.rpcEndpoint ?? 'unknown';
  const tokensPerHour      = data?.tokensPerHour;
  const txErrRate          = data?.txFetchErrorRate ?? 0;
  const walletAddr         = data?.walletAddress ?? '39azUYFWPz3VHgKCf3VChUwbpURdCHRxjWVowf5jUJjg';

  const isLive  = failures === 0 && pollCount > 0;
  const dotColor = loading ? C.gray : failures > 3 ? C.red : failures > 0 ? C.yellow : isLive ? C.green : C.gray;
  const statusLabel = loading ? 'INIT' : failures > 3 ? 'ERROR' : failures > 0 ? 'WARN' : isLive ? 'LIVE' : 'STARTING';

  return (
    <div>
      {/* ── Section header ── */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 12 }}>
        <span style={{ fontSize: 10, fontWeight: 800, letterSpacing: '0.12em', color: '#5a4080' }}>
          🚀 PUMP.FUN MIGRATION TRACKER
        </span>
        <span style={{ display: 'flex', alignItems: 'center', gap: 4, fontSize: 9, color: dotColor, fontWeight: 700 }}>
          <span style={{ display: 'inline-block', width: 6, height: 6, borderRadius: '50%', background: dotColor, boxShadow: `0 0 6px ${dotColor}` }} />
          {statusLabel}
        </span>
        <span style={{ fontSize: 9, color: C.gray, marginLeft: 'auto' }}>
          {total} total{tokensPerHour != null && ` · ${tokensPerHour}/hr`}
        </span>
      </div>

      {/* ── Tracker info card ── */}
      <div style={{ background: 'rgba(168,85,247,0.04)', border: '1px solid rgba(168,85,247,0.15)', borderRadius: 10, padding: '10px 14px', marginBottom: 14 }}>
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 12, alignItems: 'center' }}>
          <div>
            <div style={{ fontSize: 8, color: C.gray, marginBottom: 2 }}>MIGRATION WALLET</div>
            <a
              href={`https://solscan.io/account/${walletAddr}`}
              target="_blank"
              rel="noopener noreferrer"
              style={{ fontSize: 9, fontFamily: 'monospace', color: C.pump, textDecoration: 'none' }}
            >
              {walletAddr.slice(0, 8)}…{walletAddr.slice(-6)}
            </a>
          </div>
          <div style={{ width: 1, background: 'rgba(255,255,255,0.07)', alignSelf: 'stretch' }} />
          <div>
            <div style={{ fontSize: 8, color: C.gray, marginBottom: 2 }}>RPC</div>
            <span style={{ fontSize: 9, color: heliusSet ? C.green : C.yellow, fontWeight: 700 }}>
              {heliusSet ? '⚡ HELIUS' : '🌐 PUBLIC'}
            </span>
          </div>
          <div style={{ width: 1, background: 'rgba(255,255,255,0.07)', alignSelf: 'stretch' }} />
          <div>
            <div style={{ fontSize: 8, color: C.gray, marginBottom: 2 }}>POLLS</div>
            <span style={{ fontSize: 9, color: '#e0e8ff', fontVariantNumeric: 'tabular-nums' }}>{pollCount}</span>
          </div>
          <div style={{ width: 1, background: 'rgba(255,255,255,0.07)', alignSelf: 'stretch' }} />
          <div>
            <div style={{ fontSize: 8, color: C.gray, marginBottom: 2 }}>LAST POLL</div>
            <span style={{ fontSize: 9, color: lastAgoSec == null ? C.gray : lastAgoSec < 5 ? C.green : lastAgoSec < 15 ? C.yellow : C.red, fontVariantNumeric: 'tabular-nums' }}>
              {lastAgoSec == null ? 'never' : `${lastAgoSec}s ago`}
            </span>
          </div>
          {txErrRate > 0 && (
            <>
              <div style={{ width: 1, background: 'rgba(255,255,255,0.07)', alignSelf: 'stretch' }} />
              <div>
                <div style={{ fontSize: 8, color: C.gray, marginBottom: 2 }}>TX ERR</div>
                <span style={{ fontSize: 9, color: txErrRate > 20 ? C.red : C.yellow, fontVariantNumeric: 'tabular-nums' }}>{txErrRate}%</span>
              </div>
            </>
          )}
        </div>

        {/* Error / warning banners */}
        {!heliusSet && (
          <div style={{ marginTop: 8, fontSize: 9, color: C.yellow, padding: '5px 8px', borderRadius: 6, background: 'rgba(255,200,0,0.07)', border: '1px solid rgba(255,200,0,0.18)' }}>
            ⚠ HELIUS_API_KEY not set — using public RPC. Higher latency &amp; rate limits. Set HELIUS_API_KEY on Render for reliable tracking.
          </div>
        )}
        {failures > 0 && lastError && (
          <div style={{ marginTop: 8, fontSize: 9, color: failures > 3 ? C.red : C.yellow, padding: '5px 8px', borderRadius: 6, background: failures > 3 ? 'rgba(255,68,68,0.07)' : 'rgba(255,200,0,0.07)', border: `1px solid ${failures > 3 ? 'rgba(255,68,68,0.2)' : 'rgba(255,200,0,0.2)'}` }}>
            {failures > 3 ? '⛔' : '⚠'} {lastError} ({failures} consecutive failures)
          </div>
        )}
      </div>

      {/* ── Migration event list ── */}
      <div style={{ background: 'rgba(168,85,247,0.03)', border: '1px solid rgba(168,85,247,0.12)', borderRadius: 10, padding: '10px 14px' }}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 8 }}>
          <span style={{ fontSize: 8, fontWeight: 800, letterSpacing: '0.1em', color: C.pump }}>
            GRADUATED TOKENS ({total})
          </span>
          <span style={{ fontSize: 8, color: C.gray }}>polling every 1s</span>
        </div>

        {events.length === 0 ? (
          <div style={{ padding: '20px 0', textAlign: 'center', color: C.gray, fontSize: 11 }}>
            {loading
              ? 'Initialising tracker…'
              : pollCount === 0
              ? 'Waiting for first poll…'
              : 'No migrations detected yet — watching wallet'}
            <div style={{ fontSize: 9, color: '#2a3a50', marginTop: 6 }}>
              Tracking {walletAddr.slice(0, 8)}…{walletAddr.slice(-6)}
            </div>
          </div>
        ) : (
          events.slice(0, 15).map((ev, i) => (
            <MigrationRow key={ev.mint + i} ev={ev} last={i === Math.min(events.length, 15) - 1} />
          ))
        )}
      </div>
    </div>
  );
}

// ── Main page ─────────────────────────────────────────────────────────────────

export default function DiscoverPage({ sniperStatus: wsProp, wsConnected = false }: Props) {
  const polled = useSniperStatusFallback(wsConnected);
  const status = wsConnected ? (wsProp ?? polled) : (polled ?? wsProp);

  const [tick, setTick] = useState(0);
  useEffect(() => {
    const id = setInterval(() => setTick(t => t + 1), 1_000);
    return () => clearInterval(id);
  }, []);

  const now      = Date.now();
  const tracked  = (status?.trackedTokens ?? []).filter(t => t.expiresAt > now || t.entryTriggered);
  const buyLogs  = status?.recentBuyLog ?? [];
  const queued   = status?.queuedSignals ?? [];
  const stats    = status?.stats ?? { tracking: 0, positions: 0, queued: 0, pending: 0 };
  const gmgnConfigured  = status?.gmgnConfigured ?? true;
  const gmgnBannedUntil = status?.gmgnBannedUntil ?? 0;

  return (
    <div>
      {/* ── Sniper Engine header ── */}
      <div style={{ ...C.card, marginBottom: 16, background: 'linear-gradient(135deg,rgba(0,191,255,0.06),rgba(123,94,167,0.06))', borderColor: 'rgba(0,191,255,0.2)' }}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 14 }}>
          <div>
            <div style={{ fontSize: 18, fontWeight: 900, color: C.accent, letterSpacing: '0.04em' }}>🎯 SNIPER ENGINE</div>
            <div style={{ fontSize: 9, color: C.gray, marginTop: 2 }}>Pump.fun migration wallet · Smart Wallet Consensus</div>
          </div>
          <div style={{ textAlign: 'right', fontSize: 9, color: C.gray }}>
            SOL<br />
            <span style={{ fontSize: 13, fontWeight: 800, color: '#e0e8ff' }}>${status?.solPriceUsd?.toFixed(0) ?? '—'}</span>
          </div>
        </div>

        <div style={{ display: 'flex', justifyContent: 'space-around', padding: '10px 0', borderTop: '1px solid rgba(255,255,255,0.06)', borderBottom: '1px solid rgba(255,255,255,0.06)', margin: '0 -2px' }}>
          <StatPill label="Pending"    value={stats.pending ?? 0}          color={(stats.pending ?? 0) > 0 ? C.accent : C.gray} />
          <div style={{ width: 1, background: 'rgba(255,255,255,0.06)' }} />
          <StatPill label="Tracking"   value={stats.tracking} />
          <div style={{ width: 1, background: 'rgba(255,255,255,0.06)' }} />
          <StatPill label="Positions"  value={`${stats.positions}/10`}     color={stats.positions >= 10 ? C.yellow : C.green} />
          <div style={{ width: 1, background: 'rgba(255,255,255,0.06)' }} />
          <StatPill label="Queued"     value={stats.queued}                color={stats.queued > 0 ? C.yellow : C.gray} />
        </div>

        <div style={{ marginTop: 12, display: 'flex', gap: 6, flexWrap: 'wrap' }}>
          {[
            { label: 'Consensus 2x ≥80 → 1%', color: 'rgba(0,191,255,0.22)' },
            { label: 'GMGN wallet scoring',       color: 'rgba(155,89,255,0.18)' },
            { label: 'TP +100%',                  color: 'rgba(0,255,136,0.15)' },
            { label: 'SL price -30%',             color: 'rgba(255,68,102,0.12)' },
            { label: 'SL liq -40%',               color: 'rgba(255,68,102,0.12)' },
            { label: '1hr window',                color: 'rgba(255,215,0,0.10)' },
          ].map(({ label, color }) => (
            <span key={label} style={{ fontSize: 8, fontWeight: 700, padding: '2px 7px', borderRadius: 4, background: color, color: '#c0c8e0', border: '1px solid rgba(255,255,255,0.08)' }}>{label}</span>
          ))}
        </div>
      </div>

      {/* ── Queued signals ── */}
      {queued.length > 0 && (
        <div style={{ ...C.card, marginBottom: 16, borderColor: 'rgba(255,215,0,0.2)' }}>
          <div style={{ ...C.label, marginBottom: 8 }}>⏳ QUEUED SIGNALS ({queued.length})</div>
          {queued.map((sig: PendingSignal, i: number) => (
            <div key={i} style={{ display: 'flex', justifyContent: 'space-between', padding: '4px 0', borderBottom: i < queued.length - 1 ? '1px solid rgba(255,255,255,0.04)' : 'none' }}>
              <span style={{ fontSize: 10, color: '#e0e8ff', fontWeight: 700 }}>{sig.symbol}</span>
              <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                <span style={{ fontSize: 9, color: C.accent }}>🎯 {fmtUsd(sig.triggerAmountUsd)}</span>
                <span style={{ fontSize: 9, color: C.yellow }}>{sig.sizePct}% position</span>
                <span style={{ fontSize: 8, color: C.gray }}>{timeAgo(sig.queuedAt)}</span>
              </div>
            </div>
          ))}
        </div>
      )}

      {/* ── Tracked Tokens ── */}
      <div style={{ marginBottom: 16 }}>
        <div style={{ ...C.label, marginBottom: 8 }}>
          TRACKED TOKENS — 1HR WATCH WINDOW {tracked.length > 0 && `(${tracked.length})`}
        </div>
        {tracked.length === 0 ? (
          <div style={{ ...C.card, color: C.gray, fontSize: 11, textAlign: 'center', padding: '24px 16px' }}>
            Watching for qualified wallet consensus…<br />
            <span style={{ fontSize: 9, color: '#2a3a50', marginTop: 6, display: 'block' }}>
              Each graduated token tracked 1 hour for buyer wallet scoring
            </span>
          </div>
        ) : (
          tracked
            .slice()
            .sort((a, b) => b.buyerActivity.length - a.buyerActivity.length || b.migrationTime - a.migrationTime)
            .map(tok => <TrackedCard key={tok.mint} tok={tok} tick={tick} />)
        )}
      </div>

      {/* ── Wallet Signal Feed ── */}
      <div style={{ ...C.card, marginBottom: 16 }}>
        <div style={{ ...C.label, marginBottom: 2 }}>🧠 SMART WALLET SIGNAL FEED</div>
        <div style={{ fontSize: 9, color: '#2a3a50', marginBottom: 10 }}>
          Every buyer on a tracked token is scored via GMGN — entry fires only on Consensus: two+ wallets ≥80 within 5 min (Tier 2 · 1% risk · price &lt; $0.001)
        </div>
        {!gmgnConfigured && (
          <div style={{ fontSize: 10, color: C.red, padding: '6px 10px', marginBottom: 8, borderRadius: 6, background: 'rgba(255,68,68,0.08)', border: '1px solid rgba(255,68,68,0.2)' }}>
            ⚠️ GMGN_API_KEY not set — wallet scores will be 0; entries won't trigger until the key is added
          </div>
        )}
        {gmgnBannedUntil > 0 && (
          <div style={{ fontSize: 10, color: C.yellow, padding: '6px 10px', marginBottom: 8, borderRadius: 6, background: 'rgba(255,200,0,0.08)', border: '1px solid rgba(255,200,0,0.2)' }}>
            ⏳ GMGN rate-limited — scoring paused until {new Date(gmgnBannedUntil).toLocaleTimeString()}
          </div>
        )}
        {buyLogs.length === 0 ? (
          <div style={{ fontSize: 11, color: C.gray, textAlign: 'center', padding: '16px 0' }}>No buyer wallets scored yet</div>
        ) : (
          buyLogs.map((log: BuyerActivityLog, i: number) => <BuyerActivityRow key={i} entry={log} />)
        )}
      </div>

      <TransactionAuditPanel since={status?.serverStartMs} />

      {/* ── Migration tracker feed ── */}
      <MigrationFeed />
    </div>
  );
}
