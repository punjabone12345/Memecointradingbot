---
name: Whale position management
description: Architecture and gotchas for the whale sniper CRUD endpoints and frontend management UI
---

## Backend (whale-sniper.service.ts)

Six exported management functions added after `startWhaleSniper`:
- `findWhalePositionById(id)` — iterates `whalePositions` Map values; keyed by mint but looked up by id
- `manualCloseWhalePosition(id, reason)` — checks `closeLocks` first, then calls `closeWhalePosition`; returns false if position was already being closed concurrently (concurrent-close guard)
- `editWhalePositionFields(id, updates)` — edits entryPrice/currentSLPrice/triggerAmountUsd; recalculates currentSLPrice if TP1 not hit when entryPrice changes
- `deleteWhalePositionById(id)` — removes from Map, refunds `remainingSizeSol` to balance, deletes from DB, calls processQueue
- `editClosedWhalePositionById` / `deleteClosedWhalePositionById` — operate on in-memory `closedPositions` array + DB

## Routes (whale-sniper.ts)

Route ordering matters: `/closed/:id` MUST be defined before `/:id` to avoid Express matching `/closed/xyz` as `{ id: "closed" }` with extra path. Current order: GET /status → POST /:id/close → PATCH /:id → DELETE /:id → PATCH /closed/:id → DELETE /closed/:id.

## Frontend

- `loadInitial()` in App.tsx MUST include `api.getWhaleStatus()` — without it, whale positions only appear when WS fires; in paper mode with slow WS reconnects, positions were invisible
- Fallback poll (WS offline) also fetches `api.getWhaleStatus()`
- `whaleStatus` is now passed to both `MemoPositions` (always was) and `MemoAnalytics` (newly added)
- `DEFAULT_SETTINGS` must include all whale tier settings + `whaleStagnationPct: 5` to avoid TypeScript errors

## P&L math

Always use `initialSizeSol` (not `sizeSol` / `remainingSizeSol`) for P&L SOL calculations. `sizeSol` is `remainingSizeSol` after partial TP closes. Both card-level and summary-level calculations use `pos.initialSizeSol > 0 ? pos.initialSizeSol : pos.sizeSol` as fallback.

## WhaleRunnerBar

Fixed to use `pos.currentSLPrice` (from server) instead of hardcoded `entryPrice * 0.70`. SL label changes by TP stage: Hard SL → Breakeven SL → Trailing SL → Runner trailing SL.

## Analytics whale table

`WhaleClosedTable` component added to AnalyticsPage. Receives `positions` and `onRefresh`. Edit/Delete/DEX buttons per row. Edit uses inline modal (same pattern as existing auto-trader edit modal in AnalyticsPage).

## Critical: WriteFile $ corruption

When writing JSX files with `$` characters inside single-quoted string arrays (e.g., `['Entry $', 'Exit $']`), the WriteFile tool may corrupt the strings by treating `$'` as a shell ANSI-C quote sequence, splitting the string literal across lines. **Workaround:** use python3 to replace the broken content directly:
```python
content = content.replace(broken_str, fixed_str, 1)
```
Or avoid `$` in array string literals — use `'Entry Price'` instead of `'Entry $'`.
