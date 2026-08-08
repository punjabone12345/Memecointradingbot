import axios from 'axios';
import { logger } from '../lib/logger.js';

export interface RugcheckResult {
  ok: boolean;
  topHolder: number;
  creatorPct: number;
}

const cache = new Map<string, { result: RugcheckResult; ts: number }>();
const CACHE_TTL = 10 * 60_000;

export async function checkRugcheck(mint: string, maxCreatorPct = 10): Promise<RugcheckResult> {
  const cached = cache.get(mint);
  if (cached && Date.now() - cached.ts < CACHE_TTL) return cached.result;

  try {
    const res = await axios.get<{
      score?: number;
      risks?: Array<{ level: string }>;
      tokenMeta?: { mutable?: boolean };
      topHolders?: Array<{ pct: number; insider?: boolean }>;
      freezeAuthority?: string | null;
      mintAuthority?: string | null;
    }>(`https://api.rugcheck.xyz/v1/tokens/${mint}/report/summary`, { timeout: 8000 });

    const data = res.data;
    // rugcheck.xyz: LOWER score = SAFER (score of 1 is perfectly safe like USDC)
    // Higher score = more risky. We want score <= 500 to pass.
    const score = data?.score ?? 9999;

    const hasCritical = (data?.risks ?? []).some((r) => r.level === 'danger' || r.level === 'critical');
    const hasFreezeAuth = !!data?.freezeAuthority;
    const hasMintAuth = !!data?.mintAuthority;

    const topHolders = data?.topHolders ?? [];
    const topHolder = topHolders[0]?.pct ?? 0;
    const creatorPct = topHolders.filter((h) => h.insider).reduce((s, h) => s + h.pct, 0);

    const ok =
      score <= 500 &&
      !hasCritical &&
      !hasFreezeAuth &&
      !hasMintAuth &&
      topHolder < 20 &&
      creatorPct < maxCreatorPct;

    const result: RugcheckResult = { ok, topHolder, creatorPct };
    cache.set(mint, { result, ts: Date.now() });
    return result;
  } catch (err) {
    logger.debug({ err, mint }, 'Rugcheck API error — defaulting to pass');
    const result: RugcheckResult = { ok: true, topHolder: 0, creatorPct: 0 };
    cache.set(mint, { result, ts: Date.now() });
    return result;
  }
}
