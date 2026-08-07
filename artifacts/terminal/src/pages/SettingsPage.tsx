import { useState, useEffect } from 'react';
import { Settings } from '../lib/types.js';
import { api } from '../lib/api.js';

/** Returns current IST time using Intl.DateTimeFormat (correct across all host timezones). */
function getISTNow() {
  const now = new Date();
  const fmt = new Intl.DateTimeFormat('en-US', {
    timeZone: 'Asia/Kolkata',
    hour: 'numeric', minute: 'numeric', second: 'numeric', hour12: false,
  });
  const parts = fmt.formatToParts(now);
  const get = (type: string) => parseInt(parts.find(p => p.type === type)?.value ?? '0', 10);
  const h = get('hour') % 24; // normalise hour=24 (midnight) to 0
  const m = get('minute');
  const s = get('second');
  const pad = (n: number) => String(n).padStart(2, '0');
  return { hours: h, minutes: m, label: `${pad(h)}:${pad(m)}:${pad(s)} IST` };
}

function checkInWindow(enabled: boolean, start: string, end: string): boolean {
  if (!enabled) return true;
  const { hours, minutes } = getISTNow();
  const currentMin = hours * 60 + minutes;
  const [sh, sm] = start.split(':').map(Number);
  const [eh, em] = end.split(':').map(Number);
  const startMin = sh * 60 + (sm || 0);
  // "00:00" end → end of calendar day (just before midnight)
  const endMin   = (eh === 0 && (em || 0) === 0) ? 1440 : eh * 60 + (em || 0);
  if (startMin < endMin) return currentMin >= startMin && currentMin < endMin;
  return currentMin >= startMin || currentMin < endMin;
}

interface Props { settings: Settings; onUpdate: (s: Settings) => void }

function NumberInput({ label, value, onChange, min, max, step, suffix, sublabel }: {
  label: string; value: number; onChange: (v: string) => void;
  min?: number; max?: number; step?: number; suffix?: string; sublabel?: string;
}) {
  return (
    <div style={{ padding: '8px 0' }}>
      <div style={{ fontSize: 11, color: '#3a5070', fontWeight: 700, marginBottom: 4, letterSpacing: '0.04em' }}>{label}</div>
      {sublabel && <div style={{ fontSize: 10, color: '#2a3a50', marginBottom: 6, lineHeight: 1.4 }}>{sublabel}</div>}
      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        <input type="number" value={value} min={min} max={max} step={step} onChange={(e) => onChange(e.target.value)}
          className="input-premium" style={{ flex: 1 }} />
        {suffix && <span style={{ fontSize: 12, color: '#3a5070', fontWeight: 600, flexShrink: 0 }}>{suffix}</span>}
      </div>
    </div>
  );
}

function Section({ title, color = '#00d4ff', children }: { title: string; color?: string; children: React.ReactNode }) {
  return (
    <div className="card" style={{ overflow: 'hidden', marginBottom: 10 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '14px 16px', borderBottom: '1px solid rgba(255,255,255,0.05)' }}>
        <div style={{ width: 3, height: 14, borderRadius: 2, background: color }} />
        <span style={{ fontSize: 12, fontWeight: 800, letterSpacing: '0.08em', textTransform: 'uppercase', color: '#d4e0f0' }}>{title}</span>
      </div>
      <div style={{ padding: '4px 16px 14px' }}>{children}</div>
    </div>
  );
}

export default function SettingsPage({ settings: init, onUpdate }: Props) {
  const [settings, setSettings] = useState(init);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [showReset, setShowReset] = useState(false);
  const [resetInput, setResetInput] = useState('');
  const [istClock, setIstClock] = useState(getISTNow().label);

  // Live IST clock
  useEffect(() => {
    const t = setInterval(() => setIstClock(getISTNow().label), 1000);
    return () => clearInterval(t);
  }, []);

  function update(key: keyof Settings, value: string) {
    const strKeys = ['rpcEndpoint', 'walletPublicKey', 'tradingWindowStart', 'tradingWindowEnd'];
    const boolKeys = ['tradingWindowEnabled', 'botEnabled'];
    const updated = { ...settings } as Record<string, unknown>;
    if (strKeys.includes(key)) updated[key] = value;
    else if (boolKeys.includes(key)) updated[key] = value === 'true';
    else updated[key] = parseFloat(value) || 0;
    setSettings((updated as unknown) as Settings);
  }

  async function save() {
    setSaving(true);
    try {
      const updated = await api.updateSettings(settings);
      onUpdate(updated);
      setSaved(true);
      setTimeout(() => setSaved(false), 2500);
    } finally { setSaving(false); }
  }

  async function handleReset() {
    if (resetInput !== 'RESET') return;
    await api.resetAll();
    setShowReset(false);
    setResetInput('');
    window.location.reload();
  }

  const n = (k: keyof Settings) => settings[k] as number;

  return (
    <div style={{ maxWidth: 520, paddingBottom: 20 }}>

      {/* ── Master Bot On/Off Switch ────────────────────────────────────── */}
      {(() => {
        const on = settings.botEnabled;
        const winEnabled = settings.tradingWindowEnabled;
        const inWindow = checkInWindow(winEnabled, settings.tradingWindowStart, settings.tradingWindowEnd);

        // Effective running state (mirrors session-manager logic)
        const effectivelyRunning = on && (!winEnabled || inWindow);

        let statusLine: string;
        if (!on) {
          statusLine = 'Manually paused — zero Helius or Render credits consumed.';
        } else if (!winEnabled) {
          statusLine = 'Running 24/7 — no trading window restriction.';
        } else if (inWindow) {
          statusLine = `Active inside trading window (${settings.tradingWindowStart}–${settings.tradingWindowEnd} IST). Will auto-pause when window closes.`;
        } else {
          statusLine = `Waiting for trading window (${settings.tradingWindowStart} IST). Will auto-start when window opens.`;
        }

        const accentColor = effectivelyRunning ? '#00ff88' : on ? '#ffaa00' : '#ff4466';
        const borderColor = effectivelyRunning ? 'rgba(0,255,136,0.3)' : on ? 'rgba(255,170,0,0.3)' : 'rgba(255,68,102,0.3)';
        const bgColor     = effectivelyRunning ? 'rgba(0,255,136,0.04)' : on ? 'rgba(255,170,0,0.04)' : 'rgba(255,68,102,0.04)';
        const statusEmoji = effectivelyRunning ? '🟢' : on ? '🟡' : '🔴';
        const statusLabel = effectivelyRunning ? 'RUNNING' : on ? 'SCHEDULED' : 'PAUSED';

        return (
          <div className="card" style={{ marginBottom: 14, overflow: 'hidden', border: `1px solid ${borderColor}`, background: bgColor }}>
            <div style={{ padding: '16px 18px', display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 16 }}>
              <div style={{ flex: 1 }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 6 }}>
                  <span style={{ fontSize: 15 }}>{statusEmoji}</span>
                  <span style={{ fontSize: 14, fontWeight: 800, color: accentColor, letterSpacing: '0.04em' }}>
                    Bot {statusLabel}
                  </span>
                  <span style={{ fontSize: 10, color: '#3a5070', marginLeft: 2 }}>· {istClock}</span>
                </div>
                <div style={{ fontSize: 11, color: '#4a6080', lineHeight: 1.6 }}>{statusLine}</div>
              </div>
              <button
                onClick={async () => {
                  const next = !on;
                  update('botEnabled', String(next));
                  try {
                    const updated = await api.updateSettings({ ...settings, botEnabled: next });
                    onUpdate(updated);
                  } catch { /* non-fatal */ }
                }}
                style={{
                  flexShrink: 0,
                  padding: '10px 20px',
                  borderRadius: 10,
                  border: `1px solid ${on ? 'rgba(255,68,102,0.4)' : 'rgba(0,255,136,0.4)'}`,
                  background: on ? 'rgba(255,68,102,0.15)' : 'rgba(0,255,136,0.15)',
                  color: on ? '#ff4466' : '#00ff88',
                  fontSize: 12,
                  fontWeight: 800,
                  cursor: 'pointer',
                  letterSpacing: '0.06em',
                }}
              >
                {on ? 'PAUSE BOT' : 'START BOT'}
              </button>
            </div>
          </div>
        );
      })()}

      {/* ── Trading Mode Toggle ─────────────────────────────────────────── */}
      <div className="card" style={{ marginBottom: 14, overflow: 'hidden' }}>
        <div style={{ padding: '14px 16px', borderBottom: '1px solid rgba(255,255,255,0.05)', display: 'flex', alignItems: 'center', gap: 10 }}>
          <div style={{ width: 3, height: 14, borderRadius: 2, background: '#00ff88' }} />
          <span style={{ fontSize: 12, fontWeight: 800, letterSpacing: '0.08em', textTransform: 'uppercase', color: '#d4e0f0' }}>Trading Mode</span>
        </div>
        <div style={{ padding: '14px 16px', display: 'flex', flexDirection: 'column', gap: 12 }}>

          {/* Sniper Engine — always on */}
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
            <div>
              <div style={{ fontSize: 13, fontWeight: 700, color: '#00bfff' }}>🎯 Smart Wallet Consensus</div>
              <div style={{ fontSize: 11, color: '#3a5070', marginTop: 2 }}>Follows pump.fun graduations · triggers on 10s volume ≥$750</div>
            </div>
            <div style={{ padding: '4px 10px', borderRadius: 8, background: 'rgba(0,191,255,0.15)', border: '1px solid rgba(0,191,255,0.3)', fontSize: 11, fontWeight: 800, color: '#00bfff', letterSpacing: '0.04em' }}>
              ALWAYS ON
            </div>
          </div>

        </div>
      </div>

      {/* ── Trading Window ──────────────────────────────────────────────── */}
      {(() => {
        const enabled = settings.tradingWindowEnabled;
        const inWindow = checkInWindow(enabled, settings.tradingWindowStart, settings.tradingWindowEnd);
        const statusColor = !enabled ? '#7090b0' : inWindow ? '#00ff88' : '#ff4466';
        const statusLabel = !enabled ? 'UNRESTRICTED' : inWindow ? 'ACTIVE — TRADING' : 'PAUSED';
        return (
          <div className="card" style={{ marginBottom: 14, overflow: 'hidden' }}>
            <div style={{ padding: '14px 16px', borderBottom: '1px solid rgba(255,255,255,0.05)', display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                <div style={{ width: 3, height: 14, borderRadius: 2, background: '#ffaa00' }} />
                <span style={{ fontSize: 12, fontWeight: 800, letterSpacing: '0.08em', textTransform: 'uppercase', color: '#d4e0f0' }}>Trading Window (IST)</span>
              </div>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                <span style={{ fontSize: 11, color: '#3a5070' }}>{istClock}</span>
                <div style={{ padding: '3px 8px', borderRadius: 6, background: `${statusColor}22`, border: `1px solid ${statusColor}55`, fontSize: 10, fontWeight: 800, color: statusColor, letterSpacing: '0.06em' }}>
                  {statusLabel}
                </div>
              </div>
            </div>

            <div style={{ padding: '14px 16px', display: 'flex', flexDirection: 'column', gap: 14 }}>
              {/* Enable toggle */}
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
                <div>
                  <div style={{ fontSize: 13, fontWeight: 700, color: '#d4e0f0' }}>Enable trading window</div>
                  <div style={{ fontSize: 11, color: '#3a5070', marginTop: 2 }}>Restrict entries to a set IST time range. Open positions continue to be tracked 24/7.</div>
                </div>
                <button
                  onClick={() => update('tradingWindowEnabled', String(!settings.tradingWindowEnabled))}
                  style={{
                    flexShrink: 0, width: 44, height: 24, borderRadius: 12, border: 'none', cursor: 'pointer',
                    background: enabled ? '#00ff88' : 'rgba(255,255,255,0.1)',
                    transition: 'background 0.2s', position: 'relative',
                  }}
                >
                  <div style={{
                    position: 'absolute', top: 3, left: enabled ? 23 : 3, width: 18, height: 18,
                    borderRadius: '50%', background: enabled ? '#001a0a' : '#3a5070', transition: 'left 0.2s',
                  }} />
                </button>
              </div>

              {/* Time inputs */}
              {enabled && (
                <div style={{ display: 'flex', gap: 12 }}>
                  <div style={{ flex: 1 }}>
                    <div style={{ fontSize: 11, color: '#3a5070', fontWeight: 700, marginBottom: 6, letterSpacing: '0.04em' }}>Start Time (IST)</div>
                    <input
                      type="time"
                      value={settings.tradingWindowStart}
                      onChange={e => update('tradingWindowStart', e.target.value)}
                      className="input-premium"
                      style={{ width: '100%' }}
                    />
                  </div>
                  <div style={{ flex: 1 }}>
                    <div style={{ fontSize: 11, color: '#3a5070', fontWeight: 700, marginBottom: 6, letterSpacing: '0.04em' }}>End Time (IST)</div>
                    <input
                      type="time"
                      value={settings.tradingWindowEnd}
                      onChange={e => update('tradingWindowEnd', e.target.value)}
                      className="input-premium"
                      style={{ width: '100%' }}
                    />
                    <div style={{ fontSize: 10, color: '#2a3a50', marginTop: 4 }}>00:00 = midnight (end of day)</div>
                  </div>
                </div>
              )}

              {enabled && (
                <div style={{ padding: '10px 12px', borderRadius: 10, background: inWindow ? 'rgba(0,255,136,0.05)' : 'rgba(255,68,102,0.05)', border: `1px solid ${inWindow ? 'rgba(0,255,136,0.15)' : 'rgba(255,68,102,0.15)'}` }}>
                  <div style={{ fontSize: 11, color: inWindow ? '#00ff88' : '#ff4466', fontWeight: 700, marginBottom: 2 }}>
                    {inWindow ? '✅ Bot is active — new entries allowed' : '⏸ Bot is paused — no new entries until window opens'}
                  </div>
                  <div style={{ fontSize: 11, color: '#3a5070' }}>
                    Window: {settings.tradingWindowStart} → {settings.tradingWindowEnd === '00:00' ? '00:00 (midnight)' : settings.tradingWindowEnd} IST
                  </div>
                </div>
              )}
            </div>
          </div>
        );
      })()}

      {/* Sniper engine context banner */}
      <div style={{ padding: '12px 14px', borderRadius: 12, background: 'rgba(0,191,255,0.06)', border: '1px solid rgba(0,191,255,0.18)', marginBottom: 14 }}>
        <div style={{ fontSize: 11, fontWeight: 800, color: '#00bfff', letterSpacing: '0.06em', marginBottom: 4 }}>🎯 SNIPER ENGINE MODE</div>
        <div style={{ fontSize: 11, color: '#3a5070', lineHeight: 1.6 }}>
          Entry size is determined by Consensus (2+ wallets ≥80 within 5 min) — 1% risk, Tier 2 TP ladder. Positions are held <b style={{ color: '#c0c8e0' }}>indefinitely</b> — no time limit. Exit only via TP/SL, liquidity emergency, or stagnation (&lt;X% move in 1h).
        </div>
      </div>

      <Section title="Position Sizing" color="#00ff88">
        <NumberInput
          label="Starting Balance (SOL)"
          value={n('startingBalanceSol')}
          onChange={(v) => update('startingBalanceSol', v)}
          min={0.1} step={1} suffix="SOL"
          sublabel="The total portfolio used to calculate % position sizes"
        />
        <NumberInput
          label="Current Balance (SOL)"
          value={n('currentBalanceSol')}
          onChange={(v) => update('currentBalanceSol', v)}
          min={0} step={0.1} suffix="SOL"
          sublabel="Updates automatically when positions open/close in paper mode"
        />
      </Section>

      {/* Sniper TP Tiers */}
      <Section title="Sniper TP Tiers" color="#ff9900">
        <div style={{ fontSize: 11, color: '#3a5070', marginBottom: 14, lineHeight: 1.6 }}>
          Each TP exits <b style={{ color: '#c0c8e0' }}>30% of the original position</b> → 10% runner held until trailing SL. Tier is set by 10-second rolling volume at detection.
        </div>

        {/* Tier header helper */}
        {([
          { label: 'Tier 1 — $750–$1499 vol',    k: 'wt1' as const, color: '#00d4ff' },
          { label: 'Tier 2 — $1500–$2249 vol',   k: 'wt2' as const, color: '#9b59ff' },
          { label: 'Tier 3 — $2250+ vol',         k: 'wt3' as const, color: '#ff9900' },
        ] as const).map(({ label, k, color }) => (
          <div key={k} style={{ marginBottom: 18 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 10 }}>
              <div style={{ width: 3, height: 12, borderRadius: 2, background: color }} />
              <span style={{ fontSize: 11, fontWeight: 800, color, letterSpacing: '0.06em' }}>{label}</span>
            </div>

            {/* Column headers */}
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr 1fr', gap: 6, marginBottom: 4 }}>
              {['Level', 'Gain %', 'Exit %', 'SL Trail %'].map(h => (
                <div key={h} style={{ fontSize: 10, color: '#2a3a50', fontWeight: 700, letterSpacing: '0.05em' }}>{h}</div>
              ))}
            </div>

            {/* TP1 row */}
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr 1fr', gap: 6, marginBottom: 6, alignItems: 'center' }}>
              <div style={{ fontSize: 11, color: '#7090b0', fontWeight: 700 }}>TP1</div>
              <input type="number" value={n(`${k}Tp1Pct` as keyof Settings)} min={10} max={500} step={5}
                onChange={e => update(`${k}Tp1Pct` as keyof Settings, e.target.value)}
                className="input-premium" style={{ padding: '6px 8px', fontSize: 12 }} />
              <input type="number" value={n(`${k}Tp1Exit` as keyof Settings)} min={5} max={50} step={5}
                onChange={e => update(`${k}Tp1Exit` as keyof Settings, e.target.value)}
                className="input-premium" style={{ padding: '6px 8px', fontSize: 12 }} />
              <div style={{ fontSize: 10, color: '#3a5070', fontStyle: 'italic' }}>→ Breakeven</div>
            </div>

            {/* TP2 row */}
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr 1fr', gap: 6, marginBottom: 6, alignItems: 'center' }}>
              <div style={{ fontSize: 11, color: '#7090b0', fontWeight: 700 }}>TP2</div>
              <input type="number" value={n(`${k}Tp2Pct` as keyof Settings)} min={10} max={1000} step={5}
                onChange={e => update(`${k}Tp2Pct` as keyof Settings, e.target.value)}
                className="input-premium" style={{ padding: '6px 8px', fontSize: 12 }} />
              <input type="number" value={n(`${k}Tp2Exit` as keyof Settings)} min={5} max={50} step={5}
                onChange={e => update(`${k}Tp2Exit` as keyof Settings, e.target.value)}
                className="input-premium" style={{ padding: '6px 8px', fontSize: 12 }} />
              <input type="number" value={n(`${k}Tp2Trail` as keyof Settings)} min={5} max={50} step={5}
                onChange={e => update(`${k}Tp2Trail` as keyof Settings, e.target.value)}
                className="input-premium" style={{ padding: '6px 8px', fontSize: 12 }} />
            </div>

            {/* TP3 row */}
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr 1fr', gap: 6, alignItems: 'center' }}>
              <div style={{ fontSize: 11, color: '#7090b0', fontWeight: 700 }}>TP3 + Runner</div>
              <input type="number" value={n(`${k}Tp3Pct` as keyof Settings)} min={10} max={2000} step={10}
                onChange={e => update(`${k}Tp3Pct` as keyof Settings, e.target.value)}
                className="input-premium" style={{ padding: '6px 8px', fontSize: 12 }} />
              <input type="number" value={n(`${k}Tp3Exit` as keyof Settings)} min={5} max={50} step={5}
                onChange={e => update(`${k}Tp3Exit` as keyof Settings, e.target.value)}
                className="input-premium" style={{ padding: '6px 8px', fontSize: 12 }} />
              <input type="number" value={n(`${k}Tp3Trail` as keyof Settings)} min={3} max={50} step={1}
                onChange={e => update(`${k}Tp3Trail` as keyof Settings, e.target.value)}
                className="input-premium" style={{ padding: '6px 8px', fontSize: 12 }} />
            </div>
          </div>
        ))}
      </Section>

      <Section title="Stagnation Exit" color="#ff6600">
        <NumberInput
          label="Max Flat Move in 1h"
          value={n('sniperStagnationPct')}
          onChange={(v) => update('sniperStagnationPct', v)}
          min={1} max={30} step={1} suffix="%"
          sublabel="Close a sniper position if the absolute 1h price change is below this % and the position has been open for at least 1 hour. Keeps capital moving; no time-based exit otherwise."
        />
      </Section>

      <Section title="Entry Slippage" color="#ffaa00">
        <NumberInput
          label="Max Slippage vs Detected Price"
          value={n('sniperSlippagePct')}
          onChange={(v) => update('sniperSlippagePct', v)}
          min={1} max={100} step={1} suffix="%"
          sublabel="Skip a trade if the current price has pumped more than this % above the detected buyer price. Default: 20%. Telegram alert is sent on every skip."
        />
      </Section>

      {/* Save */}
      <button onClick={save} disabled={saving} className="btn-solid-cyan"
        style={{ width: '100%', padding: '16px', fontSize: 15, marginBottom: 16, opacity: saving ? 0.7 : 1 }}>
        {saving ? 'Saving…' : saved ? '✅ Saved!' : 'Save Settings'}
      </button>

      {/* Danger zone */}
      <div style={{ padding: 16, borderRadius: 16, background: 'rgba(255,68,102,0.05)', border: '1px solid rgba(255,68,102,0.18)' }}>
        <div style={{ fontSize: 11, fontWeight: 800, color: '#ff4466', letterSpacing: '0.08em', marginBottom: 6 }}>⚠️ DANGER ZONE</div>
        <p style={{ fontSize: 12, color: '#3a5070', marginBottom: 12, lineHeight: 1.5 }}>
          Closes all open positions and resets balance back to starting balance. All trade history is cleared.
        </p>
        {!showReset ? (
          <button onClick={() => setShowReset(true)} className="btn-red" style={{ padding: '10px 20px', fontSize: 13 }}>
            Reset All Data
          </button>
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
            <div style={{ fontSize: 12, color: '#ff4466', fontWeight: 700 }}>Type RESET to confirm:</div>
            <input
              type="text" value={resetInput} onChange={(e) => setResetInput(e.target.value)} placeholder="RESET"
              className="input-premium" style={{ borderColor: 'rgba(255,68,102,0.3)' }}
            />
            <div style={{ display: 'flex', gap: 8 }}>
              <button
                onClick={() => { setShowReset(false); setResetInput(''); }}
                style={{ flex: 1, padding: '10px', borderRadius: 12, background: 'rgba(255,255,255,0.05)', border: '1px solid rgba(255,255,255,0.08)', color: '#7090b0', cursor: 'pointer', fontWeight: 700 }}
              >Cancel</button>
              <button
                onClick={handleReset} disabled={resetInput !== 'RESET'} className="btn-solid-red"
                style={{ flex: 1, padding: '10px', fontSize: 13, opacity: resetInput === 'RESET' ? 1 : 0.4 }}
              >Confirm Reset</button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
