---
name: GMGN wallet_stats/wallet_activity real field shapes
description: The actual field names/nesting returned by GMGN's openapi.gmgn.ai read endpoints, verified against a live response — differs from naive/doc-guessed flat field names
---

`/v1/user/wallet_stats` (GET, exist-auth) real response shape:
- `winrate` and `avg_holding_period` (seconds) are nested under `pnl_stat`, not top-level.
- Trade counts are plain `buy` / `sell` (numbers), not `buy_count` / `sell_count`.
- The realized-ROI ratio is `realized_profit_pnl` (e.g. `-0.072` = -7.2%), not `pnl`.
- GMGN mixes numeric encodings: `pnl_stat.winrate` and `buy`/`sell` come back as JSON numbers, but
  `realized_profit_pnl`, `realized_profit`, `native_balance` etc. come back as **numeric strings**.
  Always coerce with a tolerant `toNumber()` helper rather than `typeof x === 'number'`.

`/v1/user/wallet_activity` real response shape:
- Each activity's event field is `event_type` (`'buy' | 'sell' | ...`), not `type`.
- `timestamp` is unix seconds and is present and reliable.

**Why this matters:** using the wrong field names doesn't throw — every field just reads as
`undefined`, every downstream scoring/threshold check silently evaluates false, and the score comes
out 0 for every wallet with the API key valid and calls succeeding (HTTP 200). This is very hard to
tell apart from "API key isn't working" from the logs alone — the only way to catch it is to log a
raw response body once and diff against the field names the code actually reads.

**How to apply:** before trusting any GMGN-derived scoring/threshold code, fetch one live response
(`curl`/fetch with a real wallet address) and diff its actual JSON keys against whatever the parsing
code reads. Don't trust field names from memory, older docs, or a previous implementation attempt.
