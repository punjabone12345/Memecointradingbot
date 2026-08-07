import { useState, useRef, useEffect } from 'react';
import { SniperStatus, SniperPosition, ClosedSniperPosition } from '../lib/types.js';
import { api } from '../lib/api.js';
import { formatSOL, formatPct, formatPrice } from '../lib/utils.js';

interface Props {
  sniperStatus?: SniperStatus | null;
  onRefresh: () => Promise<void>;
}

function PnlDisplay({ pnl, pct }: { pnl?: number; pct?: number }) {
  const prevPnl = useRef<number | undefined>(pnl);
  const [anim, setAnim] = useState('');
  useEffect(() => {
    if (pnl !== undefined && prevPnl.current !== undefined) {
      const prev = prevPnl.current;
      const change = Math.abs(pnl - prev);
      const threshold = Math.max(0.0001, Math.abs(prev) * 0.005);
      if (change >= threshold) {
        setAnim(pnl > prev ? 'animate-up' : 'animate-down');
        const t = setTimeout(() => setAnim(''), 600);
        prevPnl.current = pnl;
        return () => clearTimeout(t);
      }
    }
    prevPnl.current = pnl;
    return undefined;
  }, [pnl]);
  const pos = (pnl ?? 0) >= 0;
  return (
    <div className={`${anim}`} style={{ textAlign: 'right' }}>
      <div style={{ fontWeight: 900, fontSize: 15, color: pos ? '#00ff88' : '#ff4466' }}>{pnl !== undefined ? formatSOL(pnl) : '—'}</div>
      <div style={{ fontSize: 11, color: pos ? '#00ff8899' : '#ff446699' }}>{pct !== undefined ? formatPct(pct) : ''}</div>
    </div>
  );
}

function Modal({ onClose, children }: { onClose: () => void; children: React.ReactNode }) {
  return (
    <div style={{ position: 'fixed', inset: 0, zIndex: 100, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 20, background: 'rgba(0,0,0,0.75)', backdropFilter: 'blur(8px)' }} onClick={onClose}>
      <div onClick={(e) => e.stopPropagation()} style={{ background: '#0c1220', border: '1px solid rgba(255,255,255,0.1)', borderRadius: 20, padding: 24, width: '100%', maxWidth: 420, boxShadow: '0 24px 64px rgba(0,0,0,0.8)' }}>
        {children}
      </div>
    </div>
  );
}

// Flashes briefly when the price updates (driven by 1.5s monitor)
function LivePriceTicker({ price, entryPrice }: { price: number; entryPrice: number }) {
  const prev = useRef(price);
  const [flash, setFlash] = useState<'up' | 'down' | null>(null);
  useEffect(() => {
    if (price !== prev.current) {
      setFlash(price > prev.current ? 'up' : 'down');
      const t = setTimeout(() => setFlash(null), 400);
      prev.current = price;
      return () => clearTimeout(t);
    }
    return undefined;
  }, [price]);
  const isPos = price >= entryPrice;
  const flashColor = flash === 'up' ? '#00ff8866' : flash === 'down' ? '#ff446644' : 'transparent';
  return (
    <span style={{
      fontWeight: 800, fontSize: 13,
      color: isPos ? '#00ff88' : '#ff4466',
      background: flashColor,
      borderRadius: 4, padding: '1px 4px',
      transition: 'background 0.3s ease',
    }}>
      ${formatPrice(price)}
    </span>
  );
}

// ── Sniper position card ───────────────────────────────────────────────────────

// ─── Position edit modal ─────────────────────────────────────────────────────────
function PositionEditModal({ pos, onClose, onSave }: { pos: SniperPosition; onClose: () => void; onSave: () => Promise<void> }) {
  const [form, setForm] = useState({
    entryPrice: String(pos.entryPrice),
    currentSLPrice: String(pos.currentSLPrice),
    triggerAmountUsd: String(pos.triggerAmountUsd),
  });
  const [loading, setLoading] = useState(false);
  async function save() {
    setLoading(true);
    try {
      await api.editSniperPosition(pos.id, {
        entryPrice: parseFloat(form.entryPrice) || undefined,
        currentSLPrice: parseFloat(form.currentSLPrice) || undefined,
        triggerAmountUsd: parseFloat(form.triggerAmountUsd) || undefined,
      });
      await onSave();
      onClose();
    } finally { setLoading(false); }
  }
  return (
    <Modal onClose={onClose}>
      <h3 style={{ fontWeight: 900, fontSize: 16, color: '#9b59ff', marginBottom: 20 }}>Edit {pos.symbol}</h3>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
        {([['Entry Price ($)', 'entryPrice'], ['SL Price ($)', 'currentSLPrice'], ['Trigger Amount (USD)', 'triggerAmountUsd']] as const).map(([label, key]) => (
          <div key={key}>
            <div style={{ fontSize: 11, color: '#3a5070', marginBottom: 5, fontWeight: 700 }}>{label}</div>
            <input type="number" value={form[key]} onChange={(e) => setForm({ ...form, [key]: e.target.value })} className="input-premium" step="any" />
          </div>
        ))}
        <div style={{ fontSize: 10, color: '#3a5070', padding: '8px 10px', borderRadius: 8, background: 'rgba(155,89,255,0.06)', border: '1px solid rgba(155,89,255,0.15)' }}>
          Only Tier 2 (Consensus: 2+ wallets ≥80 within 5 min) entries are allowed. Price must be below $0.001.
        </div>
      </div>
      <div style={{ display: 'flex', gap: 10, marginTop: 20 }}>
        <button onClick={onClose} style={{ flex: 1, padding: 12, borderRadius: 12, background: 'rgba(255,255,255,0.05)', border: '1px solid rgba(255,255,255,0.08)', color: '#7090b0', cursor: 'pointer', fontWeight: 700 }}>Cancel</button>
        <button onClick={save} disabled={loading} style={{ flex: 1, padding: 12, borderRadius: 12, background: 'rgba(155,89,255,0.2)', border: '1px solid rgba(155,89,255,0.4)', color: '#9b59ff', cursor: 'pointer', fontWeight: 800, fontSize: 14 }}>{loading ? 'Saving…' : 'Save'}</button>
      </div>
    </Modal>
  );
}

// ─── Position close modal ────────────────────────────────────────────────────────
const WHALE_CLOSE_REASONS = ['Manual close', 'Taking profit', 'Risk management', 'Strategy change'];

function PositionCloseModal({ pos, onClose, onConfirm }: { pos: SniperPosition; onClose: () => void; onConfirm: () => Promise<void> }) {
  const [loading, setLoading] = useState(false);
  const [reason, setReason] = useState('Manual close');
  const pnlPct = pos.pnlPct;
  const initSize = pos.initialSizeSol > 0 ? pos.initialSizeSol : pos.sizeSol;
  const pnlSol = initSize * (pnlPct / 100);
  async function close() {
    setLoading(true);
    try { await api.closeSniperPosition(pos.id, reason); await onConfirm(); onClose(); }
    finally { setLoading(false); }
  }
  return (
    <Modal onClose={onClose}>
      <h3 style={{ fontWeight: 900, fontSize: 16, color: '#ff4466', marginBottom: 20 }}>Close {pos.symbol}</h3>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 8, marginBottom: 16 }}>
        {([['Current Price', `${formatPrice(pos.lastPrice)}`, '#d4e0f0'], ['P&L', `${formatSOL(pnlSol)} (${formatPct(pnlPct)})`, pnlSol >= 0 ? '#00ff88' : '#ff4466'], ['Remaining', `${pos.remainingSizeSol.toFixed(4)} SOL`, '#7090b0'], ['Banked', `${pos.bankedSol.toFixed(4)} SOL`, '#9b59ff']] as const).map(([l, v, c]) => (
          <div key={l} style={{ display: 'flex', justifyContent: 'space-between', fontSize: 13 }}>
            <span style={{ color: '#3a5070' }}>{l}</span>
            <span style={{ color: c, fontWeight: 800 }}>{v}</span>
          </div>
        ))}
      </div>
      <div style={{ marginBottom: 16 }}>
        <div style={{ fontSize: 11, color: '#3a5070', marginBottom: 6, fontWeight: 700 }}>CLOSE REASON</div>
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
          {WHALE_CLOSE_REASONS.map((r) => (
            <button key={r} onClick={() => setReason(r)} style={{ padding: '5px 10px', borderRadius: 8, fontSize: 11, fontWeight: 700, cursor: 'pointer', background: reason === r ? 'rgba(255,68,102,0.18)' : 'rgba(255,255,255,0.04)', border: reason === r ? '1px solid #ff4466' : '1px solid rgba(255,255,255,0.08)', color: reason === r ? '#ff4466' : '#7090b0' }}>{r}</button>
          ))}
        </div>
      </div>
      <div style={{ display: 'flex', gap: 10 }}>
        <button onClick={onClose} style={{ flex: 1, padding: 12, borderRadius: 12, background: 'rgba(255,255,255,0.05)', border: '1px solid rgba(255,255,255,0.08)', color: '#7090b0', cursor: 'pointer', fontWeight: 700 }}>Cancel</button>
        <button onClick={close} disabled={loading} className="btn-solid-red" style={{ flex: 1, padding: 12, fontSize: 14 }}>{loading ? 'Closing…' : 'Close Position'}</button>
      </div>
    </Modal>
  );
}

// ─── Closed-position edit modal ─────────────────────────────────────────
function ClosedPositionEditModal({ pos, onClose, onSave }: { pos: ClosedSniperPosition; onClose: () => void; onSave: () => Promise<void> }) {
  const [form, setForm] = useState({ closeReason: pos.closeReason, closePnlPct: String(pos.closePnlPct) });
  const [loading, setLoading] = useState(false);
  async function save() {
    setLoading(true);
    try {
      await api.editClosedSniperPosition(pos.id, { closeReason: form.closeReason, closePnlPct: parseFloat(form.closePnlPct) || undefined });
      await onSave();
      onClose();
    } finally { setLoading(false); }
  }
  return (
    <Modal onClose={onClose}>
      <h3 style={{ fontWeight: 900, fontSize: 16, color: '#9b59ff', marginBottom: 20 }}>Edit Closed {pos.symbol}</h3>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
        <div>
          <div style={{ fontSize: 11, color: '#3a5070', marginBottom: 5, fontWeight: 700 }}>Close Reason</div>
          <input type="text" value={form.closeReason} onChange={(e) => setForm({ ...form, closeReason: e.target.value })} className="input-premium" />
        </div>
        <div>
          <div style={{ fontSize: 11, color: '#3a5070', marginBottom: 5, fontWeight: 700 }}>Close P&L %</div>
          <input type="number" value={form.closePnlPct} onChange={(e) => setForm({ ...form, closePnlPct: e.target.value })} className="input-premium" step="0.1" />
        </div>
      </div>
      <div style={{ display: 'flex', gap: 10, marginTop: 20 }}>
        <button onClick={onClose} style={{ flex: 1, padding: 12, borderRadius: 12, background: 'rgba(255,255,255,0.05)', border: '1px solid rgba(255,255,255,0.08)', color: '#7090b0', cursor: 'pointer', fontWeight: 700 }}>Cancel</button>
        <button onClick={save} disabled={loading} style={{ flex: 1, padding: 12, borderRadius: 12, background: 'rgba(155,89,255,0.2)', border: '1px solid rgba(155,89,255,0.4)', color: '#9b59ff', cursor: 'pointer', fontWeight: 800, fontSize: 14 }}>{loading ? 'Saving…' : 'Save'}</button>
      </div>
    </Modal>
  );
}

// ─── Runner bar (uses real pos.currentSLPrice) ──────────────────────────
function RunnerBar({ pos }: { pos: SniperPosition }) {
  const pnlPct = pos.pnlPct;
  const peakGain = ((pos.peakPrice - pos.entryPrice) / pos.entryPrice) * 100;
  const slFromEntry = ((pos.currentSLPrice - pos.entryPrice) / pos.entryPrice) * 100;
  const distToSL = pos.lastPrice > 0 ? ((pos.lastPrice - pos.currentSLPrice) / pos.lastPrice) * 100 : 0;
  const color = pnlPct >= 0 ? '#00ff88' : '#ff4466';

  const slLabel = pos.tp3Hit ? 'Runner trailing SL'
    : pos.tp2Hit ? 'Trailing SL'
    : pos.tp1Hit ? 'Breakeven SL'
    : 'Hard SL';

  const lo = Math.min(slFromEntry, -35);
  const hi = Math.max(peakGain * 1.2, 100, pnlPct * 1.1);
  const range = hi - lo || 1;
  const progress  = Math.min(100, Math.max(0, ((pnlPct - lo) / range) * 100));
  const slProgress = Math.min(100, Math.max(0, ((slFromEntry - lo) / range) * 100));

  return (
    <div style={{ marginTop: 10 }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 11, marginBottom: 6 }}>
        <span style={{ color: pos.tp1Hit ? '#9b59ff' : '#ffd700', fontWeight: 800 }}>
          🎯 {slLabel}
          {pos.tp1Hit && <span style={{ color: '#00ff88', marginLeft: 6 }}>TP1✓</span>}
          {pos.tp2Hit && <span style={{ color: '#00ff88', marginLeft: 4 }}>TP2✓</span>}
          {pos.tp3Hit && <span style={{ color: '#00ff88', marginLeft: 4 }}>TP3✓</span>}
        </span>
        <span style={{ color, fontWeight: 800 }}>{pnlPct >= 0 ? '+' : ''}{pnlPct.toFixed(2)}%</span>
      </div>
      <div style={{ position: 'relative', height: 8, borderRadius: 6, background: 'rgba(255,255,255,0.06)' }}>
        <div style={{ height: '100%', borderRadius: 6, width: `${progress}%`, background: color, boxShadow: `0 0 8px ${color}55`, transition: 'width 0.3s ease' }} />
        <div style={{ position: 'absolute', top: -2, bottom: -2, left: `${slProgress}%`, width: 2, borderRadius: 1, background: '#ff4466', boxShadow: '0 0 6px #ff4466', transform: 'translateX(-50%)' }} />
      </div>
      <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 10, marginTop: 5, color: '#3a5070', fontWeight: 700 }}>
        <span style={{ color: '#ff4466' }}>SL ${formatPrice(pos.currentSLPrice)} ({slFromEntry >= 0 ? '+' : ''}{slFromEntry.toFixed(1)}%)</span>
        <span style={{ color: '#7090b0' }}>Peak +{peakGain.toFixed(1)}%</span>
      </div>
      <div style={{ marginTop: 5, padding: '5px 10px', borderRadius: 7, background: pos.tp1Hit ? 'rgba(155,89,255,0.05)' : 'rgba(255,180,0,0.05)', border: `1px solid ${pos.tp1Hit ? 'rgba(155,89,255,0.12)' : 'rgba(255,180,0,0.12)'}`, display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
        <span style={{ fontSize: 10, color: '#3a5070' }}>SL at <b style={{ color: '#ff4466' }}>${formatPrice(pos.currentSLPrice)}</b></span>
        <span style={{ fontSize: 10, fontWeight: 800, color: distToSL > 15 ? '#00ff88' : distToSL > 5 ? '#ffd700' : '#ff4466' }}>{distToSL.toFixed(1)}% away</span>
      </div>
    </div>
  );
}

// ─── Open sniper position card ─────────────────────────────────────────────────
function SniperPositionCard({ pos, solPrice, onRefresh }: { pos: SniperPosition; solPrice: number; onRefresh: () => Promise<void> }) {
  const [showEdit, setShowEdit] = useState(false);
  const [showClose, setShowClose] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const pnlPct = pos.pnlPct;
  const initSize = pos.initialSizeSol > 0 ? pos.initialSizeSol : pos.sizeSol;
  const pnlSol = initSize * (pnlPct / 100);
  const isPos = pnlPct >= 0;
  const dexUrl = `https://dexscreener.com/solana/${pos.mint}`;
  const entryMcapK = pos.entryMcap > 0 ? (pos.entryMcap / 1000).toFixed(0) : null;
  void solPrice; // used by parent for context

  async function del() {
    if (!confirm(`Delete ${pos.symbol} sniper position? Remaining ${pos.remainingSizeSol.toFixed(4)} SOL will be refunded to balance.`)) return;
    setDeleting(true);
    try { await api.deleteSniperPosition(pos.id); await onRefresh(); } finally { setDeleting(false); }
  }

  return (
    <>
      <div className={`card ${isPos ? 'card-glow-green' : 'card-glow-red'}`}
        style={{ padding: '16px', borderColor: isPos ? 'rgba(155,89,255,0.25)' : 'rgba(255,68,102,0.18)', borderWidth: 1.5 }}>
        {/* Header */}
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: 8, marginBottom: 10 }}>
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 4, flexWrap: 'wrap' }}>
              <span style={{ fontWeight: 900, fontSize: 15, color: '#d4e0f0', flexShrink: 0 }}>{pos.symbol}</span>
              <span style={{ fontSize: 11, color: '#3a5070', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', maxWidth: 80 }}>{pos.name}</span>
              <span style={{ padding: '2px 7px', borderRadius: 6, fontSize: 10, fontWeight: 700, background: 'rgba(155,89,255,0.15)', color: '#9b59ff', border: '1px solid rgba(155,89,255,0.35)', flexShrink: 0 }}>🎯 TIER T{pos.tpTier}</span>
              {entryMcapK && <span style={{ padding: '2px 7px', borderRadius: 6, fontSize: 10, fontWeight: 700, background: 'rgba(0,212,255,0.08)', color: '#00d4ff', border: '1px solid rgba(0,212,255,0.2)', flexShrink: 0 }}>Entry {entryMcapK}k MC</span>}
              <span title="Price updating every 1.5s" style={{ display: 'inline-flex', alignItems: 'center', gap: 3, fontSize: 9, color: '#00ff88', fontWeight: 800, flexShrink: 0 }}>
                <span style={{ display: 'inline-block', width: 5, height: 5, borderRadius: '50%', background: '#00ff88', boxShadow: '0 0 5px #00ff88', animation: 'pulse-dot 0.8s ease-in-out infinite' }} />
                LIVE
              </span>
            </div>
            <div style={{ fontSize: 11, color: '#3a5070' }}>
              {new Date(pos.entryTime).toLocaleTimeString('en-IN', { timeZone: 'Asia/Kolkata', hour: '2-digit', minute: '2-digit', second: '2-digit' })} IST
              {' · '}${(pos.triggerAmountUsd).toFixed(0)} vol trigger
              {pos.entryDelayMs != null && (
                <span style={{ marginLeft: 4, color: '#00d4ff', fontWeight: 700 }}>
                  +{(pos.entryDelayMs / 1000).toFixed(1)}s after signal
                </span>
              )}
            </div>
          </div>
          <div style={{ flexShrink: 0 }}>
            <PnlDisplay pnl={pnlSol} pct={pnlPct} />
          </div>
        </div>

        {/* Metrics */}
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '6px 16px', marginBottom: 10 }}>
          <div style={{ fontSize: 11 }}><span style={{ color: '#3a5070' }}>Entry </span><b style={{ color: '#d4e0f0' }}>${formatPrice(pos.entryPrice)}</b></div>
          <div style={{ fontSize: 11 }}><span style={{ color: '#3a5070' }}>Current </span><LivePriceTicker price={pos.lastPrice} entryPrice={pos.entryPrice} /></div>
          <div style={{ fontSize: 11 }}>
            <span style={{ color: '#3a5070' }}>Init size </span>
            <b style={{ color: '#d4e0f0' }}>{initSize.toFixed(3)} SOL</b>
          </div>
          <div style={{ fontSize: 11 }}>
            <span style={{ color: '#3a5070' }}>Remaining </span>
            <b style={{ color: pos.tp1Hit ? '#9b59ff' : '#d4e0f0' }}>{pos.remainingSizeSol.toFixed(3)} SOL</b>
          </div>
          <div style={{ fontSize: 11 }}>
            <span style={{ color: '#3a5070' }}>Banked </span>
            <b style={{ color: '#00ff88' }}>{pos.bankedSol.toFixed(4)} SOL</b>
          </div>
          <div style={{ fontSize: 11 }}>
            <span style={{ color: '#3a5070' }}>Liquidity </span>
            <b style={{ color: pos.lastLiquidity > 5000 ? '#00ff88' : '#ffd700' }}>${(pos.lastLiquidity / 1000).toFixed(1)}k</b>
          </div>
        </div>

        <RunnerBar pos={pos} />

        {/* Action buttons */}
        <div style={{ display: 'flex', gap: 8, marginTop: 12, flexWrap: 'wrap' }}>
          <a href={dexUrl} target="_blank" rel="noopener noreferrer" className="btn-primary" style={{ padding: '7px 12px', fontSize: 11, textDecoration: 'none' }}>DEX ↗</a>
          <a href={`https://solscan.io/token/${pos.mint}`} target="_blank" rel="noopener noreferrer" style={{ padding: '7px 12px', fontSize: 11, borderRadius: 12, background: 'rgba(155,89,255,0.08)', border: '1px solid rgba(155,89,255,0.2)', color: '#9b59ff', textDecoration: 'none', fontWeight: 700 }}>SolScan ↗</a>
          <button onClick={() => setShowEdit(true)} className="btn-primary" style={{ padding: '7px 12px', fontSize: 11 }}>Edit</button>
          <button onClick={() => setShowClose(true)} className="btn-red" style={{ padding: '7px 12px', fontSize: 11 }}>Close</button>
          <button onClick={del} disabled={deleting} style={{ padding: '7px 12px', fontSize: 11, borderRadius: 12, background: 'rgba(255,255,255,0.04)', border: '1px solid rgba(255,255,255,0.08)', color: '#3a5070', cursor: 'pointer' }}>
            {deleting ? '…' : 'Delete'}
          </button>
        </div>
      </div>
      {showEdit  && <PositionEditModal  pos={pos} onClose={() => setShowEdit(false)}  onSave={onRefresh} />}
      {showClose && <PositionCloseModal pos={pos} onClose={() => setShowClose(false)} onConfirm={onRefresh} />}
    </>
  );
}

// ─── Closed sniper position card ───────────────────────────────────────────────
function ClosedPositionCard({ pos, onRefresh }: { pos: ClosedSniperPosition; onRefresh: () => Promise<void> }) {
  const [showEdit, setShowEdit] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const pnlPos = pos.closePnlPct >= 0;
  const initSize = pos.initialSizeSol > 0 ? pos.initialSizeSol : pos.sizeSol;
  const pnlSol = initSize * (pos.closePnlPct / 100);
  const dexUrl = `https://dexscreener.com/solana/${pos.mint}`;
  const entryMcapK = pos.entryMcap > 0 ? (pos.entryMcap / 1000).toFixed(0) : null;

  async function del() {
    if (!confirm(`Delete ${pos.symbol} closed sniper trade?`)) return;
    setDeleting(true);
    try { await api.deleteClosedSniperPosition(pos.id); await onRefresh(); } finally { setDeleting(false); }
  }

  return (
    <>
      <div className="card" style={{ padding: '14px 16px', borderColor: pnlPos ? 'rgba(155,89,255,0.12)' : 'rgba(255,68,102,0.1)' }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start' }}>
          <div>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 4, flexWrap: 'wrap' }}>
              <span style={{ fontWeight: 800, fontSize: 14, color: '#d4e0f0' }}>{pos.symbol}</span>
              <span style={{ fontSize: 10, color: '#3a5070' }}>{pos.name}</span>
              <span style={{ padding: '1px 6px', borderRadius: 5, fontSize: 9, fontWeight: 800, background: 'rgba(155,89,255,0.12)', color: '#9b59ff', border: '1px solid rgba(155,89,255,0.28)' }}>🎯 T{pos.tpTier}</span>
              {entryMcapK && <span style={{ fontSize: 10, color: '#3a5070' }}>@ {entryMcapK}k MC</span>}
            </div>
            <div style={{ fontSize: 10, color: '#3a5070', marginBottom: 3 }}>
              {new Date(pos.entryTime).toLocaleTimeString('en-IN', { timeZone: 'Asia/Kolkata', hour: '2-digit', minute: '2-digit' })} → {pos.closeTime ? new Date(pos.closeTime).toLocaleTimeString('en-IN', { timeZone: 'Asia/Kolkata', hour: '2-digit', minute: '2-digit' }) : '—'} IST
            </div>
            {pos.closeReason && <div style={{ fontSize: 10, color: '#7090b0', fontStyle: 'italic' }}>{pos.closeReason}</div>}
          </div>
          <div style={{ textAlign: 'right' }}>
            <div style={{ fontWeight: 900, fontSize: 14, color: pnlPos ? '#00ff88' : '#ff4466' }}>{formatSOL(pnlSol)}</div>
            <div style={{ fontSize: 11, color: pnlPos ? '#00ff8899' : '#ff446699' }}>{formatPct(pos.closePnlPct)}</div>
          </div>
        </div>
        <div style={{ display: 'flex', gap: 10, marginTop: 8, fontSize: 11, flexWrap: 'wrap', alignItems: 'center' }}>
          <span style={{ color: '#3a5070' }}>Entry <b style={{ color: '#7090b0' }}>${formatPrice(pos.entryPrice)}</b></span>
          <span style={{ color: '#3a5070' }}>Exit <b style={{ color: '#7090b0' }}>${formatPrice(pos.lastPrice)}</b></span>
          <span style={{ color: '#3a5070' }}>Size <b style={{ color: '#7090b0' }}>{initSize.toFixed(3)} SOL</b></span>
          <span style={{ color: '#3a5070' }}>Banked <b style={{ color: '#9b59ff' }}>{pos.bankedSol.toFixed(3)} SOL</b></span>
          <a href={dexUrl} target="_blank" rel="noopener noreferrer" style={{ color: '#9b59ff', textDecoration: 'none', fontWeight: 700 }}>DEX ↗</a>
          <button onClick={() => setShowEdit(true)} style={{ padding: '4px 8px', fontSize: 10, borderRadius: 8, background: 'rgba(0,212,255,0.1)', border: '1px solid rgba(0,212,255,0.25)', color: '#00d4ff', cursor: 'pointer', fontWeight: 700 }}>Edit</button>
          <button onClick={del} disabled={deleting} style={{ padding: '4px 8px', fontSize: 10, borderRadius: 8, background: 'rgba(255,68,102,0.1)', border: '1px solid rgba(255,68,102,0.25)', color: '#ff4466', cursor: 'pointer', fontWeight: 700 }}>
            {deleting ? '…' : 'Delete'}
          </button>
        </div>
      </div>
      {showEdit && <ClosedPositionEditModal pos={pos} onClose={() => setShowEdit(false)} onSave={onRefresh} />}
    </>
  );
}

// ── Main page ─────────────────────────────────────────────────────────────────

export default function PositionsPage({ sniperStatus, onRefresh }: Props) {
  const openPositions   = sniperStatus?.openPositions   ?? [];
  const closedPositions = sniperStatus?.closedPositions  ?? [];
  const solPrice    = sniperStatus?.solPriceUsd ?? 0;

  // Unrealized PnL (pnlPct accounts for banked partial closes)
  const unrealizedPnl = openPositions.reduce((s, p) => {
    const initSize = p.initialSizeSol > 0 ? p.initialSizeSol : p.sizeSol;
    return s + initSize * (p.pnlPct / 100);
  }, 0);

  // Today's P&L
  const todayStr = new Date().toDateString();
  const dailyPnl = closedPositions.reduce((sum, p) => {
    if (new Date(p.closeTime).toDateString() !== todayStr) return sum;
    const initSize = p.initialSizeSol > 0 ? p.initialSizeSol : p.sizeSol;
    return sum + initSize * (p.closePnlPct / 100);
  }, 0);

  // Win rate
  const wins = closedPositions.filter(p => p.closePnlPct > 0).length;
  const winRate = closedPositions.length > 0 ? (wins / closedPositions.length) * 100 : 0;

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
      {/* Summary stats */}
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8 }}>
        {[
          { label: 'Open Positions', value: String(openPositions.length), color: '#00d4ff' },
          { label: 'Unrealized PNL', value: `${unrealizedPnl >= 0 ? '+' : ''}${unrealizedPnl.toFixed(4)} SOL`, color: unrealizedPnl >= 0 ? '#00ff88' : '#ff4466' },
          { label: "Today's PNL", value: `${dailyPnl >= 0 ? '+' : ''}${dailyPnl.toFixed(4)} SOL`, color: dailyPnl >= 0 ? '#00ff88' : '#ff4466' },
          { label: 'Win Rate', value: `${winRate.toFixed(1)}%`, color: '#ffd700' },
        ].map((s) => (
          <div key={s.label} className="card" style={{ padding: '14px 16px' }}>
            <div style={{ fontSize: 17, fontWeight: 900, color: s.color, lineHeight: 1.1 }}>{s.value}</div>
            <div style={{ fontSize: 10, color: '#3a5070', marginTop: 5, fontWeight: 700, letterSpacing: '0.06em', textTransform: 'uppercase' }}>{s.label}</div>
          </div>
        ))}
      </div>

      {/* Live feed badge */}
      {openPositions.length > 0 && (
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '6px 14px', borderRadius: 8, background: 'rgba(0,255,136,0.04)', border: '1px solid rgba(0,255,136,0.1)', fontSize: 10 }}>
          <span style={{ display: 'inline-block', width: 6, height: 6, borderRadius: '50%', background: '#00ff88', boxShadow: '0 0 6px #00ff88', animation: 'pulse-dot 0.8s ease-in-out infinite' }} />
          <span style={{ color: '#00ff88', fontWeight: 800 }}>LIVE</span>
          <span style={{ color: '#3a5070' }}>Prices update every <b style={{ color: '#7090b0' }}>1.5s</b> · Buy detection via Helius WS + 2s poll</span>
        </div>
      )}

      {/* ── Sniper engine open positions ── */}
      <div className="section-label" style={{ marginTop: 4, display: 'flex', alignItems: 'center', gap: 8 }}>
        <span>🎯 Sniper Positions ({openPositions.length})</span>
        {sniperStatus && (
          <span style={{ fontSize: 10, color: '#3a5070', fontWeight: 500 }}>
            · watching {sniperStatus.stats.tracking} token{sniperStatus.stats.tracking !== 1 ? 's' : ''}
          </span>
        )}
      </div>

      {openPositions.length === 0 ? (
        <div className="card" style={{ padding: '28px 20px', textAlign: 'center', color: '#3a5070' }}>
          <div style={{ fontSize: 32, marginBottom: 8 }}>🎯</div>
          <div style={{ fontWeight: 700, color: '#7090b0', marginBottom: 4 }}>No sniper positions yet</div>
          <div style={{ fontSize: 12 }}>
            {sniperStatus
              ? `Tracking ${sniperStatus.stats.tracking} token${sniperStatus.stats.tracking !== 1 ? 's' : ''} · watching 10s volume ≥$750`
              : 'Watching for consensus entries on graduated tokens…'}
          </div>
        </div>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
          {openPositions.map((p) => <SniperPositionCard key={p.id} pos={p} solPrice={solPrice} onRefresh={onRefresh} />)}
        </div>
      )}

      {/* ── Sniper engine closed positions — always visible so fast-close trades are never hidden ── */}
      <div className="section-label" style={{ marginTop: 8, display: 'flex', alignItems: 'center', gap: 8 }}>
        <span>🎯 Closed Sniper Positions</span>
        {closedPositions.length > 0 && (
          <span style={{ fontSize: 11, fontWeight: 700, color: '#00d4ff', background: 'rgba(0,212,255,0.12)', borderRadius: 6, padding: '1px 7px' }}>
            {closedPositions.length}
          </span>
        )}
      </div>
      {closedPositions.length === 0 ? (
        <div className="card" style={{ padding: '16px 20px', textAlign: 'center', color: '#3a5070', fontSize: 12 }}>
          No closed positions yet — fast-closing trades appear here immediately
        </div>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
          {closedPositions.slice(0, 20).map((p) => <ClosedPositionCard key={p.id} pos={p} onRefresh={onRefresh} />)}
        </div>
      )}
    </div>
  );
}
