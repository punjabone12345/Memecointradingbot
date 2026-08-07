---
name: Whale position live display
description: How whale sniper positions are shown live in the Trades tab, and the Helius WS integration for fast detection
---

# Whale positions in Trades tab

## Architecture
- `whaleStatus` prop flows from App.tsx → PositionsPage via WebSocket `whale_status` messages
- PositionsPage renders WhalePositionCard (open) and ClosedWhaleCard (closed) in dedicated sections
- Live price ticks: backend position monitor runs every 1.5s, broadcasts via WS

## Whale sniper speed
- Buy poll: 2s non-overlapping sweep (reduced from 5s)
- Position monitor: 1.5s (reduced from 3s)
- Helius WS: logsSubscribe {mentions: [mint]} per tracked mint when HELIUS_API_KEY set → near-instant detection

## Re-entrancy safety
- `pollLocks` Set prevents concurrent pollTokenBuys for same mint (WS-triggered vs scheduled)
- `entryLocks` prevents double entry, `closeLocks` prevents double close
- WS confirmation handler checks `trackedTokens.has(mint)` before promoting — orphan subs unsubscribed immediately
- `wsUnsubscribeMint` also clears `_pendingWsReqs` so late confirmations for pruned mints are rejected

## entryMcap field
- Added to WhalePosition interface and DB (ADD COLUMN IF NOT EXISTS entry_mcap)
- Stored from TrackedToken.mcap at entry time; displayed as "Entry 70k MC" badge in UI

**Why:** User wanted Telegram trade notifications to appear live in the Positions/Trades tab with live price updates. Whale positions were already in whaleStatus but never rendered in PositionsPage.
