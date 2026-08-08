/**
 * Trade Funnel Diagnostics Page
 *
 * Shows the full discovery → filter → trade pipeline with per-token
 * rejection reasons so the user can see exactly why the bot is taking
 * (or not taking) trades.
 */

import { useState, useEffect, useCallback } from 'react';
import { api } from '../lib/api.js';
import {
  DiagToken, DiagError, DiagFunnelStats, DiagDailySummary, SniperStatus,
} from '../lib/types.js';

// ── Helpers ───────────────────────────────────────────────────────────────────

function fmtNum(n: string | number | null | undefined): string {
  const v = Number(n ?? 0);
  if (v >= 1_000_000) return `${(v / 1_000_000).toFixed(2)}M`;
  if (v >= 1_000)     return `${(v / 1_000).toFixed(1)}K`;
  return v.toFixed(0);
}

function fmtTs(ms: number | string | null | undefined): string {
  if (!ms) return '—';
  const n = Number(ms); // node-pg returns BIGINT as string; coerce to number before Date()
  if (!Number.isFinite(n) || n <= 0) return '—';
  return new Date(n).toLocaleTimeString('en-IN', { timeZone: 'Asia/Kolkata', hour: '2-digit', minute: '2-digit', second: '2-digit' });
}

function timeAgo(ms: number | null | undefined): string {
  if (!ms) return '—';
  const s = Math.floor((Date.now() - ms) / 1_000);
  if (s < 60)  return `${s}s ago`;
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  return `${Math.floor(s / 3600)}h ago`;
}

const C = {
  bg:       '#080d1a',
  card:     { background: 'rgba(255,255,255,0.03)', border: '1px solid rgba(255,255,255,0.07)', borderRadius: 10, overflow: 'hidden' as const },
  label:    { fontSize: 9, fontWeight: 800, letterSpacing: '0.12em', color: '#3a5070', textTransform: 'uppercase' as const },
  green:    '#00ff88',
  yellow:   '#ffd700',
  red:      '#ff4466',
  blue:     '#00d4ff',
  purple:   '#9b59ff',
  gray:     '#4a6080',
  text:     '#d4e0f0',
};

const STATUS_COLOR: Record<string, string> = {
  TRADED:    C.green,
  REJECTED:  C.red,
  EXPIRED:   C.gray,
  TRACKED:   C.blue,
  DISCOVERED: C.yellow,
};

const STATUS_ICON: Record<string, string> = {
  TRADED:    '✅',
  REJECTED:  '❌',
  EXPIRED:   '⏰',
  TRACKED:   '👁',
  DISCOVERED: '🔍',
};

// ── Sub-components ────────────────────────────────────────────────────────────

function SectionHeader({ title, sub }: { title: string; sub?: string }) {
  return (
    <div style={{ padding: '12px 14px', borderBottom: '1px solid rgba(255,255,255,0.06)', background: 'rgba(0,0,0,0.2)' }}>
      <div style={{ fontWeight: 800, color: C.purple, fontSize: 12 }}>{title}</div>
      {sub && <div style={{ fontSize: 10, color: C.gray, marginTop: 2 }}>{sub}</div>}
    </div>
  );
}

function MiniStat({ label, value, color }: { label: string; value: string | number; color?: string }) {
  return (
    <div style={{ textAlign: 'center', padding: '10px 8px' }}>
      <div style={{ fontSize: 20, fontWeight: 900, color: color ?? C.text, lineHeight: 1 }}>{value}</div>
      <div style={{ fontSize: 9, color: C.gray, marginTop: 4, fontWeight: 700, letterSpacing: '0.06em', textTransform: 'uppercase' }}>{label}</div>
    </div>
  );
}

function FilterPass({ passed }: { passed: boolean | null }) {
  if (passed === null) return <span style={{ color: C.gray, fontSize: 10 }}>—</span>;
  return <span style={{ color: passed ? C.green : C.red, fontSize: 12 }}>{passed ? '✓' : '✗'}</span>;
}

// ── Funnel Bar ────────────────────────────────────────────────────────────────

function FunnelBar({ label, count, total, color }: { label: string; count: number; total: number; color: string }) {
  const pct = total > 0 ? (count / total) * 100 : 0;
  return (
    <div style={{ marginBottom: 8 }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 4 }}>
        <span style={{ fontSize: 11, color: C.text, fontWeight: 700 }}>{label}</span>
        <span style={{ fontSize: 11, color, fontWeight: 800 }}>{count} <span style={{ color: C.gray, fontWeight: 400 }}>({pct.toFixed(1)}%)</span></span>
      </div>
      <div style={{ height: 6, borderRadius: 3, background: 'rgba(255,255,255,0.06)', overflow: 'hidden' }}>
        <div style={{ width: `${pct}%`, height: '100%', borderRadius: 3, background: color, transition: 'width 0.5s ease' }} />
      </div>
    </div>
  );
}

// ── Funnel Panel ─────────────────────────────────────────────────────────────

function FunnelPanel({ funnel }: { funnel: DiagFunnelStats | null }) {
  if (!funnel) return (
    <div style={{ ...C.card, marginBottom: 10 }}>
      <SectionHeader title="📊 Discovery Funnel (Last 7 Days)" />
      <div style={{ padding: 24, textAlign: 'center', color: C.gray, fontSize: 11 }}>Loading…</div>
    </div>
  );

  const total = parseInt(funnel.total, 10) || 1;
  const steps = [
    { label: 'Total Discovered',        count: parseInt(funnel.total, 10),               color: C.blue },
    { label: 'Passed Liquidity Filter', count: parseInt(funnel.ever_passed_liquidity, 10), color: '#00bfff' },
    { label: 'Passed Wallet Score',     count: parseInt(funnel.ever_passed_wallet, 10),    color: C.purple },
    { label: 'Reached Entry Gate',      count: parseInt(funnel.ever_reached_entry, 10),    color: C.yellow },
    { label: 'Actually Traded',         count: parseInt(funnel.traded, 10),                color: C.green },
  ];

  const rejBreakdown = [
    { label: 'Wallet / Score', count: parseInt(funnel.rejected_wallet, 10),    color: C.purple },
    { label: 'Liquidity / SOL', count: parseInt(funnel.rejected_liquidity, 10), color: C.red },
    { label: 'Token Age',       count: parseInt(funnel.rejected_age, 10),       color: C.yellow },
    { label: 'Freeze Authority', count: parseInt(funnel.rejected_freeze, 10),   color: '#ff8844' },
    { label: 'Slippage',        count: parseInt(funnel.rejected_slippage, 10),  color: '#ff6644' },
    { label: 'Pool / Prune',    count: parseInt(funnel.rejected_pool, 10),      color: C.gray },
    { label: 'Other',           count: parseInt(funnel.rejected_other, 10),     color: '#6688aa' },
  ];

  return (
    <div style={{ ...C.card, marginBottom: 10 }}>
      <SectionHeader title="📊 Discovery Funnel (Last 7 Days)" sub="How many tokens pass each stage of the pipeline" />
      <div style={{ padding: '14px 16px' }}>
        {steps.map(s => <FunnelBar key={s.label} label={s.label} count={s.count} total={total} color={s.color} />)}
        <div style={{ marginTop: 16, paddingTop: 12, borderTop: '1px solid rgba(255,255,255,0.06)' }}>
          <div style={{ ...C.label, marginBottom: 10 }}>Rejection breakdown</div>
          {rejBreakdown.filter(r => r.count > 0).map(r => (
            <FunnelBar key={r.label} label={r.label} count={r.count} total={parseInt(funnel.total, 10) - parseInt(funnel.traded, 10)} color={r.color} />
          ))}
          {rejBreakdown.every(r => r.count === 0) && (
            <div style={{ color: C.gray, fontSize: 11, textAlign: 'center', padding: '8px 0' }}>No rejections yet</div>
          )}
        </div>
      </div>
    </div>
  );
}

// ── Daily Summary Panel ───────────────────────────────────────────────────────

function SummaryPanel({ summary }: { summary: DiagDailySummary | null }) {
  if (!summary) return null;

  const s = summary;
  const n = (v: string) => parseInt(v, 10);

  const statsGrid = [
    { label: 'Discovered',     value: s.total_discovered,  color: C.blue },
    { label: 'Total Scans',    value: s.total_scans,        color: C.text },
    { label: 'Avg Scans/Token', value: `${parseFloat(s.avg_scans).toFixed(1)}×`, color: C.text },
    { label: 'Passed Liquidity', value: s.passed_liquidity, color: '#00bfff' },
    { label: 'Passed Wallet',  value: s.passed_wallet,      color: C.purple },
    { label: 'Reached Entry',  value: s.passed_entry,       color: C.yellow },
    { label: 'Traded',         value: s.total_traded,       color: C.green },
    { label: 'Rejected',       value: s.total_rejected,     color: C.red },
    { label: 'Expired',        value: s.total_expired,      color: C.gray },
  ];

  return (
    <div style={{ ...C.card, marginBottom: 10 }}>
      <SectionHeader title={`📅 Today's Summary — ${s.date}`} sub="Tokens discovered and processed since UTC midnight" />
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 1, background: 'rgba(255,255,255,0.04)' }}>
        {statsGrid.map(st => (
          <div key={st.label} style={{ background: C.bg, padding: '10px 8px', textAlign: 'center' }}>
            <div style={{ fontSize: 18, fontWeight: 900, color: st.color, lineHeight: 1 }}>{st.value}</div>
            <div style={{ fontSize: 9, color: C.gray, marginTop: 3, fontWeight: 700, letterSpacing: '0.05em', textTransform: 'uppercase' }}>{st.label}</div>
          </div>
        ))}
      </div>

      {/* Rejection breakdown */}
      {s.rejectionBreakdown.length > 0 && (
        <div style={{ padding: '12px 14px', borderTop: '1px solid rgba(255,255,255,0.06)' }}>
          <div style={{ ...C.label, marginBottom: 8 }}>Rejection Reasons</div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
            {s.rejectionBreakdown.map((r, i) => (
              <div key={i} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', fontSize: 11 }}>
                <span style={{ color: C.text, flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{r.reject_reason}</span>
                <span style={{ color: C.red, fontWeight: 800, marginLeft: 8, flexShrink: 0 }}>{r.count}×</span>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Error summary */}
      {s.errorSummary.length > 0 && (
        <div style={{ padding: '12px 14px', borderTop: '1px solid rgba(255,255,255,0.06)' }}>
          <div style={{ ...C.label, marginBottom: 8 }}>API / Technical Errors Today</div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
            {s.errorSummary.map((e, i) => (
              <div key={i} style={{ display: 'flex', justifyContent: 'space-between', fontSize: 11 }}>
                <span style={{ color: C.yellow, fontWeight: 700 }}>{e.error_type}</span>
                <span style={{ color: C.gray }}>{e.count}×</span>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

// ── Token Row (expandable) ────────────────────────────────────────────────────

function TokenRow({ tok, expanded, onToggle }: { tok: DiagToken; expanded: boolean; onToggle: () => void }) {
  const status = tok.status;
  const statusColor = STATUS_COLOR[status] ?? C.gray;
  const statusIcon  = STATUS_ICON[status]  ?? '?';

  const filters = [
    { key: 'MC',       passed: tok.passed_mc_at        != null },
    { key: 'Liq',      passed: tok.passed_liquidity_at != null },
    { key: 'Vol',      passed: tok.passed_volume_at    != null },
    { key: 'Rug',      passed: tok.passed_rugcheck_at  != null },
    { key: 'Hold',     passed: tok.passed_holder_at    != null },
    { key: 'Wallet',   passed: tok.passed_wallet_at    != null },
    { key: 'Entry',    passed: tok.passed_entry_at     != null },
  ];

  return (
    <>
      <tr
        onClick={onToggle}
        style={{ borderTop: '1px solid rgba(255,255,255,0.04)', cursor: 'pointer', background: expanded ? 'rgba(155,89,255,0.05)' : 'transparent' }}
      >
        <td style={{ padding: '8px 10px', whiteSpace: 'nowrap' }}>
          <div style={{ fontWeight: 800, color: C.text, fontSize: 11 }}>{tok.symbol || '?'}</div>
          <div style={{ fontSize: 9, color: C.gray }}>{tok.name?.slice(0, 12) || '—'}</div>
        </td>
        <td style={{ padding: '8px 10px' }}>
          <span style={{ fontSize: 9, fontWeight: 800, color: statusColor }}>
            {statusIcon} {status}
          </span>
        </td>
        <td style={{ padding: '8px 10px', fontSize: 10, color: C.gray, whiteSpace: 'nowrap' }}>
          {fmtTs(tok.first_seen_at)}
        </td>
        <td style={{ padding: '8px 10px', fontSize: 10, color: '#c0d0e0', whiteSpace: 'nowrap' }}>
          ${fmtNum(tok.highest_mc)}
        </td>
        <td style={{ padding: '8px 10px', fontSize: 10, color: '#c0d0e0', whiteSpace: 'nowrap' }}>
          ${fmtNum(tok.highest_liquidity)}
        </td>
        <td style={{ padding: '8px 10px' }}>
          <div style={{ display: 'flex', gap: 4, flexWrap: 'wrap' }}>
            {filters.map(f => (
              <span key={f.key} style={{ fontSize: 8, fontWeight: 800, padding: '1px 4px', borderRadius: 3, background: f.passed ? 'rgba(0,255,136,0.1)' : 'rgba(255,68,102,0.08)', color: f.passed ? C.green : 'rgba(255,68,102,0.6)', border: `1px solid ${f.passed ? 'rgba(0,255,136,0.2)' : 'rgba(255,68,102,0.15)'}` }}>
                {f.key}
              </span>
            ))}
          </div>
        </td>
        <td style={{ padding: '8px 10px', maxWidth: 160 }}>
          {tok.reject_reason ? (
            <span style={{ fontSize: 9, color: C.red, display: 'block', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={tok.reject_reason}>
              {tok.reject_reason}
            </span>
          ) : status === 'TRADED' ? (
            <span style={{ fontSize: 9, color: C.green }}>Trade executed ✅</span>
          ) : (
            <span style={{ fontSize: 9, color: C.gray }}>—</span>
          )}
        </td>
        <td style={{ padding: '8px 10px', fontSize: 9, color: C.gray }}>
          {tok.scan_count}×
        </td>
      </tr>
      {expanded && (
        <tr style={{ background: 'rgba(155,89,255,0.04)' }}>
          <td colSpan={8} style={{ padding: '12px 14px' }}>
            <TokenDetail tok={tok} />
          </td>
        </tr>
      )}
    </>
  );
}

function TokenDetail({ tok }: { tok: DiagToken }) {
  const dexUrl = `https://dexscreener.com/solana/${tok.mint}`;

  const filterRows = [
    { label: 'Market Cap',      passed: tok.passed_mc_at,        at: tok.passed_mc_at },
    { label: 'Liquidity',       passed: tok.passed_liquidity_at, at: tok.passed_liquidity_at },
    { label: 'Volume',          passed: tok.passed_volume_at,    at: tok.passed_volume_at },
    { label: 'Rugcheck',        passed: tok.passed_rugcheck_at,  at: tok.passed_rugcheck_at },
    { label: 'Holder',          passed: tok.passed_holder_at,    at: tok.passed_holder_at },
    { label: 'Creator',         passed: tok.passed_creator_at,   at: tok.passed_creator_at },
    { label: 'Wallet Score',    passed: tok.passed_wallet_at,    at: tok.passed_wallet_at },
    { label: 'Entry Criteria',  passed: tok.passed_entry_at,     at: tok.passed_entry_at },
  ];

  return (
    <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
      {/* Left: market peaks */}
      <div>
        <div style={{ ...C.label, marginBottom: 8 }}>Peak Market Data</div>
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 6, fontSize: 10 }}>
          {[
            ['Peak MC',          `$${fmtNum(tok.highest_mc)}`],
            ['Peak Liquidity',   `$${fmtNum(tok.highest_liquidity)}`],
            ['Peak Volume',      `$${fmtNum(tok.highest_volume)}`],
            ['Peak Wallet Score', String(tok.highest_wallet_score ?? 0)],
            ['Peak Qual. Wallets', String(tok.highest_qualifying_wallets ?? 0)],
            ['Scans',            String(tok.scan_count)],
          ].map(([l, v]) => (
            <div key={l}>
              <div style={{ color: C.gray, fontSize: 9 }}>{l}</div>
              <div style={{ color: C.text, fontWeight: 700 }}>{v}</div>
            </div>
          ))}
        </div>
        <div style={{ marginTop: 10 }}>
          <div style={{ ...C.label, marginBottom: 4 }}>Source / Discovery</div>
          <span style={{ fontSize: 10, color: C.blue, fontWeight: 700 }}>{tok.discovery_source}</span>
          <span style={{ fontSize: 9, color: C.gray }}> · first seen {timeAgo(tok.first_seen_at)}</span>
        </div>
        <div style={{ marginTop: 8 }}>
          <a href={dexUrl} target="_blank" rel="noopener noreferrer" style={{ fontSize: 9, color: C.yellow, textDecoration: 'none', fontWeight: 700 }}>↗ View on DexScreener</a>
          <span style={{ fontSize: 9, color: C.gray, display: 'block', fontFamily: 'monospace', marginTop: 2 }}>{tok.mint.slice(0, 20)}…</span>
        </div>
      </div>

      {/* Right: filter pass/fail */}
      <div>
        <div style={{ ...C.label, marginBottom: 8 }}>Filter Pipeline</div>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
          {filterRows.map(r => (
            <div key={r.label} style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 10 }}>
              <FilterPass passed={r.passed != null ? true : null} />
              <span style={{ color: r.passed ? C.text : C.gray, flex: 1 }}>{r.label}</span>
              {r.at && <span style={{ color: C.gray, fontSize: 9 }}>{fmtTs(r.at)}</span>}
            </div>
          ))}
        </div>
        {tok.reject_reason && (
          <div style={{ marginTop: 10, padding: '8px 10px', borderRadius: 6, background: 'rgba(255,68,102,0.08)', border: '1px solid rgba(255,68,102,0.2)' }}>
            <div style={{ fontSize: 9, color: C.red, fontWeight: 800 }}>REJECTION REASON</div>
            <div style={{ fontSize: 10, color: '#ffaaaa', marginTop: 2 }}>{tok.reject_reason}</div>
          </div>
        )}
        {tok.status === 'TRADED' && tok.entry_mode && (
          <div style={{ marginTop: 10, padding: '8px 10px', borderRadius: 6, background: 'rgba(0,255,136,0.06)', border: '1px solid rgba(0,255,136,0.18)' }}>
            <div style={{ fontSize: 9, color: C.green, fontWeight: 800 }}>TRADE DETAILS</div>
            <div style={{ fontSize: 10, color: '#aaffcc', marginTop: 2 }}>
              {tok.entry_mode === 'consensus' ? `Consensus (${tok.entry_qualifying_wallets} wallets ≥80)` : `Entry mode: ${tok.entry_mode ?? 'unknown'}`}
              {tok.entry_price != null && <><br />{`Entry: $${tok.entry_price.toFixed(8)}`}</>}
              {tok.entry_mc != null && <><br />{`MC: $${fmtNum(tok.entry_mc)}`}</>}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

// ── Token Table ───────────────────────────────────────────────────────────────

type StatusFilter = 'ALL' | 'TRACKED' | 'REJECTED' | 'EXPIRED' | 'TRADED';

function TokenTable({ since }: { since?: number }) {
  const [statusFilter, setStatusFilter] = useState<StatusFilter>('ALL');
  const [rows, setRows]         = useState<DiagToken[]>([]);
  const [total, setTotal]       = useState(0);
  const [page, setPage]         = useState(0);
  const [loading, setLoading]   = useState(false);
  const [expanded, setExpanded] = useState<string | null>(null);
  const LIMIT = 50;

  const load = useCallback(async (status: StatusFilter, p: number) => {
    setLoading(true);
    try {
      const result = await api.getDiagTokens({
        status: status === 'ALL' ? undefined : status,
        limit: LIMIT,
        offset: p * LIMIT,
        since,
      });
      setRows(result.rows);
      setTotal(result.total);
    } catch { /* ignore */ } finally {
      setLoading(false);
    }
  }, [since]);

  useEffect(() => { load(statusFilter, page); }, [statusFilter, page, load, since]);

  const tabs: { id: StatusFilter; label: string; color: string }[] = [
    { id: 'ALL',       label: 'All',      color: C.text },
    { id: 'TRACKED',   label: 'Tracking', color: C.blue },
    { id: 'REJECTED',  label: 'Rejected', color: C.red },
    { id: 'EXPIRED',   label: 'Expired',  color: C.gray },
    { id: 'TRADED',    label: 'Traded',   color: C.green },
  ];

  return (
    <div style={{ ...C.card, marginBottom: 10 }}>
      <SectionHeader
        title="🔬 Token Pipeline — All Discovered Tokens"
        sub="Click any row to expand and see why it passed or failed each filter"
      />

      {/* Status filter tabs */}
      <div style={{ display: 'flex', gap: 2, padding: '10px 12px', borderBottom: '1px solid rgba(255,255,255,0.06)', flexWrap: 'wrap' }}>
        {tabs.map(t => (
          <button
            key={t.id}
            onClick={() => { setStatusFilter(t.id); setPage(0); setExpanded(null); }}
            style={{
              padding: '4px 10px', borderRadius: 5, fontSize: 10, fontWeight: 800, border: 'none', cursor: 'pointer',
              background: statusFilter === t.id ? 'rgba(155,89,255,0.2)' : 'rgba(255,255,255,0.04)',
              color: statusFilter === t.id ? t.color : C.gray,
              outline: statusFilter === t.id ? `1px solid ${t.color}55` : 'none',
            }}
          >
            {t.label}
          </button>
        ))}
        <span style={{ marginLeft: 'auto', fontSize: 10, color: C.gray, alignSelf: 'center' }}>
          {loading ? 'Loading…' : `${total} tokens`}
        </span>
      </div>

      <div style={{ overflowX: 'auto' }}>
        <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 11 }}>
          <thead>
            <tr style={{ background: 'rgba(255,255,255,0.02)' }}>
              {['Token', 'Status', 'First Seen (IST)', 'Peak MC', 'Peak Liq', 'Filters Passed', 'Rejection Reason', 'Scans'].map(h => (
                <th key={h} style={{ padding: '8px 10px', textAlign: 'left', color: C.gray, whiteSpace: 'nowrap', fontWeight: 700, fontSize: 9, letterSpacing: '0.05em', textTransform: 'uppercase' }}>{h}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.length === 0 && !loading ? (
              <tr><td colSpan={8} style={{ textAlign: 'center', padding: '32px', color: C.gray }}>
                <div style={{ fontSize: 28, marginBottom: 8 }}>🔍</div>
                {statusFilter === 'ALL' ? 'No tokens discovered yet — bot is scanning' : `No ${statusFilter.toLowerCase()} tokens`}
              </td></tr>
            ) : rows.map(tok => (
              <TokenRow
                key={tok.mint}
                tok={tok}
                expanded={expanded === tok.mint}
                onToggle={() => setExpanded(expanded === tok.mint ? null : tok.mint)}
              />
            ))}
          </tbody>
        </table>
      </div>

      {/* Pagination */}
      {total > LIMIT && (
        <div style={{ display: 'flex', justifyContent: 'center', gap: 8, padding: '10px', borderTop: '1px solid rgba(255,255,255,0.06)' }}>
          <button
            onClick={() => setPage(p => Math.max(0, p - 1))}
            disabled={page === 0}
            style={{ padding: '5px 12px', fontSize: 10, borderRadius: 5, border: '1px solid rgba(255,255,255,0.1)', background: 'rgba(255,255,255,0.04)', color: page === 0 ? C.gray : C.text, cursor: page === 0 ? 'default' : 'pointer' }}
          >
            ← Prev
          </button>
          <span style={{ fontSize: 10, color: C.gray, alignSelf: 'center' }}>
            Page {page + 1} of {Math.ceil(total / LIMIT)}
          </span>
          <button
            onClick={() => setPage(p => p + 1)}
            disabled={(page + 1) * LIMIT >= total}
            style={{ padding: '5px 12px', fontSize: 10, borderRadius: 5, border: '1px solid rgba(255,255,255,0.1)', background: 'rgba(255,255,255,0.04)', color: (page + 1) * LIMIT >= total ? C.gray : C.text, cursor: (page + 1) * LIMIT >= total ? 'default' : 'pointer' }}
          >
            Next →
          </button>
        </div>
      )}
    </div>
  );
}

// ── Top Rejected Panel ────────────────────────────────────────────────────────

function TopRejectedPanel({ since }: { since?: number }) {
  const [rows, setRows] = useState<DiagToken[]>([]);
  const [loading, setLoading] = useState(false);
  const [expanded, setExpanded] = useState<string | null>(null);

  useEffect(() => {
    setLoading(true);
    api.getDiagTopRejected({ since })
      .then(r => setRows(r.rows))
      .catch(() => {})
      .finally(() => setLoading(false));
  }, [since]);

  return (
    <div style={{ ...C.card, marginBottom: 10 }}>
      <SectionHeader
        title="🏆 Top 20 Near-Miss Tokens"
        sub="Tokens that came closest to being traded, ranked by how far they got through the pipeline"
      />
      {loading && <div style={{ padding: 20, textAlign: 'center', color: C.gray, fontSize: 11 }}>Loading…</div>}
      {!loading && rows.length === 0 && (
        <div style={{ padding: 20, textAlign: 'center', color: C.gray, fontSize: 11 }}>No rejected tokens yet</div>
      )}
      {!loading && rows.length > 0 && (
        <div style={{ overflowX: 'auto' }}>
          <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 11 }}>
            <thead>
              <tr style={{ background: 'rgba(255,255,255,0.02)' }}>
                {['#', 'Token', 'Score', 'Peak MC', 'Peak Liq', 'Wallet Score', 'Wallets', 'Rejection Reason'].map(h => (
                  <th key={h} style={{ padding: '8px 10px', textAlign: 'left', color: C.gray, fontWeight: 700, fontSize: 9, letterSpacing: '0.05em', textTransform: 'uppercase', whiteSpace: 'nowrap' }}>{h}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {rows.map((tok, i) => (
                <>
                  <tr
                    key={tok.mint}
                    onClick={() => setExpanded(expanded === tok.mint ? null : tok.mint)}
                    style={{ borderTop: '1px solid rgba(255,255,255,0.04)', cursor: 'pointer', background: expanded === tok.mint ? 'rgba(155,89,255,0.05)' : 'transparent' }}
                  >
                    <td style={{ padding: '8px 10px', color: C.gray, fontWeight: 700 }}>#{i + 1}</td>
                    <td style={{ padding: '8px 10px' }}>
                      <div style={{ fontWeight: 800, color: C.text }}>{tok.symbol || '?'}</div>
                      <div style={{ fontSize: 9, color: C.gray }}>{tok.name?.slice(0, 10)}</div>
                    </td>
                    <td style={{ padding: '8px 10px' }}>
                      <span style={{ fontWeight: 800, color: C.yellow, fontSize: 13 }}>{(tok as any).proximity_score ?? '—'}</span>
                      <span style={{ fontSize: 9, color: C.gray }}>/100</span>
                    </td>
                    <td style={{ padding: '8px 10px', color: '#c0d0e0', whiteSpace: 'nowrap' }}>${fmtNum(tok.highest_mc)}</td>
                    <td style={{ padding: '8px 10px', color: '#c0d0e0', whiteSpace: 'nowrap' }}>${fmtNum(tok.highest_liquidity)}</td>
                    <td style={{ padding: '8px 10px' }}>
                      <span style={{ fontWeight: 800, color: tok.highest_wallet_score >= 80 ? C.green : tok.highest_wallet_score >= 50 ? C.yellow : C.gray }}>
                        {tok.highest_wallet_score ?? 0}
                      </span>
                    </td>
                    <td style={{ padding: '8px 10px', color: C.text }}>{tok.highest_qualifying_wallets ?? 0}</td>
                    <td style={{ padding: '8px 10px', maxWidth: 160 }}>
                      <span style={{ fontSize: 9, color: C.red, display: 'block', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={tok.reject_reason ?? ''}>
                        {tok.reject_reason ?? <span style={{ color: C.gray }}>Expired</span>}
                      </span>
                    </td>
                  </tr>
                  {expanded === tok.mint && (
                    <tr key={tok.mint + '-detail'} style={{ background: 'rgba(155,89,255,0.04)' }}>
                      <td colSpan={8} style={{ padding: '12px 14px' }}>
                        <TokenDetail tok={tok} />
                      </td>
                    </tr>
                  )}
                </>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

// ── Error Log Panel ───────────────────────────────────────────────────────────

function ErrorLogPanel() {
  const [rows, setRows]         = useState<DiagError[]>([]);
  const [loading, setLoading]   = useState(false);
  const [typeFilter, setTypeFilter] = useState('');

  const load = useCallback(() => {
    setLoading(true);
    api.getDiagErrors({ limit: 100 })
      .then(r => setRows(r.rows))
      .catch(() => {})
      .finally(() => setLoading(false));
  }, []);

  useEffect(() => { load(); }, [load]);

  const types = Array.from(new Set(rows.map(r => r.error_type))).sort();
  const filtered = typeFilter ? rows.filter(r => r.error_type === typeFilter) : rows;

  const counts = types.reduce((m, t) => {
    m[t] = rows.filter(r => r.error_type === t).length;
    return m;
  }, {} as Record<string, number>);

  return (
    <div style={{ ...C.card, marginBottom: 10 }}>
      <SectionHeader title="⚠️ Technical Error Log" sub="API timeouts, RPC failures, price fetch errors — last 100 events" />

      {/* Error type summary pills */}
      {types.length > 0 && (
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, padding: '10px 14px', borderBottom: '1px solid rgba(255,255,255,0.06)' }}>
          <button
            onClick={() => setTypeFilter('')}
            style={{ fontSize: 9, fontWeight: 800, padding: '3px 8px', borderRadius: 4, border: 'none', cursor: 'pointer', background: !typeFilter ? 'rgba(155,89,255,0.2)' : 'rgba(255,255,255,0.04)', color: !typeFilter ? C.purple : C.gray }}
          >
            All ({rows.length})
          </button>
          {types.map(t => (
            <button
              key={t}
              onClick={() => setTypeFilter(typeFilter === t ? '' : t)}
              style={{ fontSize: 9, fontWeight: 800, padding: '3px 8px', borderRadius: 4, border: 'none', cursor: 'pointer', background: typeFilter === t ? 'rgba(255,215,0,0.15)' : 'rgba(255,255,255,0.04)', color: typeFilter === t ? C.yellow : C.gray }}
            >
              {t} ({counts[t]})
            </button>
          ))}
        </div>
      )}

      {loading && <div style={{ padding: 20, textAlign: 'center', color: C.gray, fontSize: 11 }}>Loading…</div>}
      {!loading && filtered.length === 0 && (
        <div style={{ padding: 20, textAlign: 'center', color: C.gray, fontSize: 11 }}>
          <div style={{ fontSize: 24, marginBottom: 6 }}>✅</div>
          No technical errors logged
        </div>
      )}
      {!loading && filtered.length > 0 && (
        <div>
          {filtered.slice(0, 50).map((err, i) => (
            <div key={err.id} style={{ padding: '8px 14px', borderBottom: i < filtered.length - 1 ? '1px solid rgba(255,255,255,0.04)' : 'none', display: 'flex', gap: 10, alignItems: 'flex-start' }}>
              <div style={{ flexShrink: 0, textAlign: 'right', minWidth: 50 }}>
                <div style={{ fontSize: 8, color: C.gray }}>{fmtTs(err.occurred_at)}</div>
              </div>
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ display: 'flex', gap: 6, alignItems: 'center', flexWrap: 'wrap' }}>
                  <span style={{ fontSize: 9, fontWeight: 800, padding: '1px 5px', borderRadius: 3, background: 'rgba(255,215,0,0.1)', color: C.yellow, border: '1px solid rgba(255,215,0,0.2)' }}>
                    {err.error_type}
                  </span>
                  {err.mint && <span style={{ fontSize: 9, color: C.gray, fontFamily: 'monospace' }}>{err.mint.slice(0, 8)}…</span>}
                </div>
                <div style={{ fontSize: 10, color: '#c0c8d8', marginTop: 2, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{err.message}</div>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

// ── Main page ─────────────────────────────────────────────────────────────────

interface DiagnosticsPageProps {
  sniperStatus?: SniperStatus | null;
}

export default function DiagnosticsPage({ sniperStatus }: DiagnosticsPageProps) {
  const [funnel,  setFunnel]  = useState<DiagFunnelStats | null>(null);
  const [summary, setSummary] = useState<DiagDailySummary | null>(null);
  const [tab, setTab]         = useState<'funnel' | 'tokens' | 'top' | 'errors'>('funnel');

  // Only show tokens from the current server session — reset cleanly after each push/restart
  const since = sniperStatus?.serverStartMs;

  useEffect(() => {
    api.getDiagFunnel({ since }).then(setFunnel).catch(() => {});
    api.getDiagSummary().then(setSummary).catch(() => {});
  }, [since]);

  const tabDefs: { id: typeof tab; label: string }[] = [
    { id: 'funnel',  label: '📊 Funnel' },
    { id: 'tokens',  label: '🔬 Tokens' },
    { id: 'top',     label: '🏆 Near Misses' },
    { id: 'errors',  label: '⚠️ Errors' },
  ];

  const totalDiscovered = summary?.total_discovered ?? funnel?.total ?? '—';
  const totalTraded     = summary?.total_traded ?? funnel?.traded ?? '—';
  const totalRejected   = summary?.total_rejected ?? '—';

  return (
    <div>
      {/* Header summary */}
      <div style={{ ...C.card, marginBottom: 10, background: 'linear-gradient(135deg,rgba(155,89,255,0.06),rgba(0,191,255,0.04))', borderColor: 'rgba(155,89,255,0.2)' }}>
        <div style={{ padding: '12px 14px 0' }}>
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', flexWrap: 'wrap', gap: 6 }}>
            <div style={{ fontSize: 16, fontWeight: 900, color: C.purple }}>🔍 TRADE FUNNEL DIAGNOSTICS</div>
            {since && (
              <div style={{ fontSize: 9, fontWeight: 700, padding: '2px 8px', borderRadius: 5, background: 'rgba(0,255,136,0.08)', border: '1px solid rgba(0,255,136,0.2)', color: '#00ff88' }}>
                ✓ This session only · started {timeAgo(since)}
              </div>
            )}
          </div>
          <div style={{ fontSize: 9, color: C.gray, marginTop: 1 }}>Showing only tokens discovered since the last server start. Push to GitHub → Render restart clears this automatically.</div>
        </div>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 1, background: 'rgba(255,255,255,0.04)', marginTop: 10 }}>
          <MiniStat label="Discovered Today"   value={totalDiscovered}                             color={C.blue} />
          <MiniStat label="Traded Today"        value={totalTraded}                                 color={C.green} />
          <MiniStat label="Rejected Today"      value={totalRejected}                               color={C.red} />
          <MiniStat label="Avg Scans/Token"     value={summary ? `${parseFloat(summary.avg_scans).toFixed(1)}×` : '—'} color={C.text} />
        </div>
      </div>

      {/* Sub-tabs */}
      <div style={{ display: 'flex', gap: 4, marginBottom: 10, flexWrap: 'wrap' }}>
        {tabDefs.map(t => (
          <button
            key={t.id}
            onClick={() => setTab(t.id)}
            style={{
              padding: '7px 12px', borderRadius: 7, fontSize: 11, fontWeight: 800, border: 'none', cursor: 'pointer',
              background: tab === t.id ? 'rgba(155,89,255,0.2)' : 'rgba(255,255,255,0.04)',
              color: tab === t.id ? C.purple : C.gray,
              outline: tab === t.id ? '1px solid rgba(155,89,255,0.4)' : 'none',
            }}
          >
            {t.label}
          </button>
        ))}
      </div>

      {tab === 'funnel'  && <><FunnelPanel funnel={funnel} /><SummaryPanel summary={summary} /></>}
      {tab === 'tokens'  && <TokenTable since={since} />}
      {tab === 'top'     && <TopRejectedPanel since={since} />}
      {tab === 'errors'  && <ErrorLogPanel />}
    </div>
  );
}
