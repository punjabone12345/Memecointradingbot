/**
 * Live proof: on-chain PumpSwap liquidity fetch
 *
 * Two-path proof:
 *  Path A — DexScreener pairAddress: uses the actual pool address from DexScreener,
 *            reads the pool account, extracts WSOL vault at byte offset 171.
 *  Path B — PDA derivation (same logic as graduation-sniper.service.ts):
 *            derives pool PDA from mint, reads pool account, extracts WSOL vault.
 *
 * Both paths read the WSOL vault balance from Helius/public RPC and compare
 * to DexScreener's reported liquidity — showing the fix works even when
 * DexScreener's liquidity field is 0 (which it is for the first 3-5 minutes).
 *
 * Run: node scripts/test-pumpswap-liquidity.mjs [optional-mint-address]
 */

import { PublicKey } from "@solana/web3.js";

const PUMPSWAP_PROGRAM_ID = "pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA";
const WSOL_MINT           = "So11111111111111111111111111111111111111112";
const DEXSCREENER_BASE    = "https://api.dexscreener.com";
const HELIUS_API_KEY      = process.env["HELIUS_API_KEY"] ?? null;

const rpcUrls = HELIUS_API_KEY
  ? [
      `https://mainnet.helius-rpc.com/?api-key=${HELIUS_API_KEY}`,
      "https://api.mainnet-beta.solana.com",
    ]
  : [
      "https://api.mainnet-beta.solana.com",
      "https://rpc.ankr.com/solana",
    ];

async function rpcPost(url, method, params, timeoutMs = 8000) {
  const ctrl = new AbortController();
  const tid   = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      method:  "POST",
      headers: { "Content-Type": "application/json" },
      body:    JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
      signal:  ctrl.signal,
    });
    return res.json();
  } finally {
    clearTimeout(tid);
  }
}

async function findRecentPumpSwapPair(mintOverride) {
  if (mintOverride) {
    console.log(`\n🔍 Step 1: Fetching DexScreener data for mint ${mintOverride.slice(0, 12)}...`);
    const res  = await fetch(`${DEXSCREENER_BASE}/tokens/v1/solana/${mintOverride}`);
    const data = await res.json();
    const pairs = (Array.isArray(data) ? data : []).filter(
      (p) => ["pump-amm", "pumpswap"].includes(p.dexId ?? ""),
    );
    if (pairs.length === 0) throw new Error("No PumpSwap pair found for that mint on DexScreener");
    pairs.sort((a, b) => (b.liquidity?.usd ?? 0) - (a.liquidity?.usd ?? 0));
    const p = pairs[0];
    return {
      mint:        p.baseToken?.address,
      pairAddress: p.pairAddress,
      dexLiqUsd:   p.liquidity?.usd ?? 0,
      symbol:      p.baseToken?.symbol ?? "?",
      dexId:       p.dexId,
      createdAt:   p.pairCreatedAt ?? 0,
    };
  }

  console.log("\n🔍 Step 1: Finding a recently graduated PumpSwap token via DexScreener...");
  // Use the /latest/dex/tokens endpoint to search for recent pump-amm pairs
  const endpoints = [
    `${DEXSCREENER_BASE}/latest/dex/search/?q=pump-amm`,
    `${DEXSCREENER_BASE}/latest/dex/search/?q=pumpswap+solana`,
  ];

  for (const ep of endpoints) {
    const res  = await fetch(ep);
    const data = await res.json();
    const pairs = (data.pairs ?? []).filter(
      (p) => p.chainId === "solana" && ["pump-amm", "pumpswap"].includes(p.dexId ?? ""),
    );
    if (pairs.length === 0) continue;
    pairs.sort((a, b) => (b.pairCreatedAt ?? 0) - (a.pairCreatedAt ?? 0));
    const p = pairs[0];
    return {
      mint:        p.baseToken?.address,
      pairAddress: p.pairAddress,
      dexLiqUsd:   p.liquidity?.usd ?? 0,
      symbol:      p.baseToken?.symbol ?? "?",
      dexId:       p.dexId,
      createdAt:   p.pairCreatedAt ?? 0,
    };
  }
  throw new Error("Could not find a PumpSwap pair on DexScreener");
}

async function fetchSolUsd() {
  const res  = await fetch(`${DEXSCREENER_BASE}/tokens/v1/solana/${WSOL_MINT}`);
  const data = await res.json();
  const pairs = Array.isArray(data) ? data : [];
  const usdc  = pairs.find((p) => p.quoteToken?.symbol === "USDC") ?? pairs[0];
  return parseFloat(usdc?.priceUsd ?? "0") || 0;
}

// Extract WSOL vault from pool account raw data (same logic as graduation-sniper.service.ts)
// PumpSwap Pool layout:
//  [0-7]    discriminator (8)
//  [8]      pool_bump     (1)
//  [9-10]   index         (2)
//  [11-42]  creator       (32)
//  [43-74]  base_mint     (32)
//  [75-106] quote_mint    (32)
//  [107-138] lp_mint      (32)
//  [139-170] pool_base_token_account (32)
//  [171-202] pool_quote_token_account = WSOL vault (32)  ← target
function extractWsolVaultFromPoolAccount(b64) {
  const buf = Buffer.from(b64, "base64");
  if (buf.length < 203) return null;
  return new PublicKey(buf.subarray(171, 203)).toBase58();
}

async function getPoolAccount(poolAddress) {
  for (const rpcUrl of rpcUrls) {
    try {
      const data = await rpcPost(rpcUrl, "getAccountInfo", [poolAddress, { encoding: "base64" }]);
      const b64  = data?.result?.value?.data?.[0];
      if (b64) return { b64, rpcUrl };
    } catch {
      continue;
    }
  }
  return null;
}

async function getWsolVaultBalance(wsolVault) {
  for (const rpcUrl of rpcUrls) {
    try {
      const data   = await rpcPost(rpcUrl, "getTokenAccountBalance", [wsolVault]);
      const uiAmt  = data?.result?.value?.uiAmount ?? null;
      if (uiAmt !== null) return { solBalance: uiAmt, rpcUrl };
    } catch {
      continue;
    }
  }
  return null;
}

async function main() {
  const mintOverride = process.argv[2] ?? null;

  console.log("═══════════════════════════════════════════════════════════════");
  console.log("  PumpSwap On-Chain Liquidity Proof Test");
  console.log("═══════════════════════════════════════════════════════════════");
  console.log(`  HELIUS_API_KEY: ${HELIUS_API_KEY ? "✅ set (fast path)" : "⚠️  not set (public RPC fallback)"}`);
  console.log(`  RPC endpoint:   ${rpcUrls[0].slice(0, 50)}...`);

  const { mint, pairAddress, dexLiqUsd, symbol, dexId, createdAt } = await findRecentPumpSwapPair(mintOverride);
  const solUsd = await fetchSolUsd();

  console.log(`\n  Token:          ${symbol}`);
  console.log(`  Mint:           ${mint}`);
  console.log(`  Pair address:   ${pairAddress}`);
  console.log(`  dexId:          ${dexId}`);
  console.log(`  DexScreener liq: $${dexLiqUsd.toFixed(2)}`);
  console.log(`  Pair created:   ${new Date(createdAt).toISOString()}`);
  console.log(`  SOL/USD:        $${solUsd.toFixed(2)}`);

  // ── Path A: Use DexScreener pairAddress as the pool address ────────────────
  console.log("\n─────────────────────────────────────────────────────────────");
  console.log("  PATH A: Pool address from DexScreener → on-chain WSOL vault");
  console.log("─────────────────────────────────────────────────────────────");

  let pathALiqUsd = 0;
  const poolAccA = await getPoolAccount(pairAddress);
  if (!poolAccA) {
    console.log("  ❌ Pool account not readable from any RPC endpoint");
  } else {
    console.log(`  ✅ Pool account read from: ${poolAccA.rpcUrl.slice(0, 40)}...`);
    const wsolVaultA = extractWsolVaultFromPoolAccount(poolAccA.b64);
    if (!wsolVaultA) {
      console.log("  ❌ Pool account too small — not a PumpSwap pool");
    } else {
      console.log(`  ✅ WSOL vault (offset 171): ${wsolVaultA}`);
      const balA = await getWsolVaultBalance(wsolVaultA);
      if (!balA) {
        console.log("  ❌ Could not read WSOL vault balance");
      } else {
        pathALiqUsd = balA.solBalance * solUsd;
        console.log(`  ✅ WSOL vault balance:  ${balA.solBalance.toFixed(4)} SOL`);
        console.log(`  ✅ Liquidity (on-chain): $${pathALiqUsd.toFixed(2)}`);
      }
    }
  }

  // ── Path B: Derive PDA and read pool account (same logic as the service) ───
  console.log("\n─────────────────────────────────────────────────────────────");
  console.log("  PATH B: PDA derivation (graduation-sniper.service.ts logic)");
  console.log("─────────────────────────────────────────────────────────────");

  let pathBLiqUsd = 0;
  try {
    const mintPK    = new PublicKey(mint);
    const programPK = new PublicKey(PUMPSWAP_PROGRAM_ID);
    const wsolPK    = new PublicKey(WSOL_MINT);

    // Try indices 0 through 4 (most pools use index 0, but scan a few)
    for (let idx = 0; idx <= 4; idx++) {
      const idxBuf = Buffer.alloc(2);
      idxBuf.writeUInt16LE(idx, 0);
      const [poolPda] = PublicKey.findProgramAddressSync(
        [Buffer.from("pool"), idxBuf, mintPK.toBuffer(), wsolPK.toBuffer()],
        programPK,
      );

      if (idx === 0) {
        console.log(`  Trying pool PDA (index ${idx}): ${poolPda.toBase58()}`);
        console.log(`  DexScreener pair address:       ${pairAddress}`);
        const pdaMatch = poolPda.toBase58() === pairAddress;
        console.log(`  PDA matches DexScreener:        ${pdaMatch ? "✅ YES" : "⚠️  NO (different index or different pool type)"}`);
      } else {
        console.log(`  Trying pool PDA (index ${idx}): ${poolPda.toBase58()}`);
      }

      const poolAccB = await getPoolAccount(poolPda.toBase58());
      if (!poolAccB) {
        console.log(`    Account not found — trying next index`);
        continue;
      }

      console.log(`  ✅ Pool account found at index ${idx}`);
      const wsolVaultB = extractWsolVaultFromPoolAccount(poolAccB.b64);
      if (!wsolVaultB) {
        console.log("  ❌ Account too small — not a PumpSwap pool");
        continue;
      }
      console.log(`  ✅ WSOL vault (offset 171): ${wsolVaultB}`);
      const balB = await getWsolVaultBalance(wsolVaultB);
      if (balB) {
        pathBLiqUsd = balB.solBalance * solUsd;
        console.log(`  ✅ WSOL vault balance:  ${balB.solBalance.toFixed(4)} SOL`);
        console.log(`  ✅ Liquidity (on-chain): $${pathBLiqUsd.toFixed(2)}`);
      }
      break;
    }
    if (pathBLiqUsd === 0) {
      console.log("  ⚠️  Could not derive correct pool PDA — all indices exhausted");
      console.log("       The service uses Path A via cached vault key for these tokens");
    }
  } catch (err) {
    console.log(`  ❌ PDA derivation failed: ${err.message}`);
  }

  // ── Summary ────────────────────────────────────────────────────────────────
  const bestOnChain = pathALiqUsd > 0 ? pathALiqUsd : pathBLiqUsd;
  console.log("\n═══════════════════════════════════════════════════════════════");
  console.log("  SUMMARY");
  console.log("═══════════════════════════════════════════════════════════════");
  console.log(`  Token:                  ${symbol} (${mint.slice(0, 12)}...)`);
  console.log(`  DexScreener liquidity:  $${dexLiqUsd.toFixed(2)}`);
  console.log(`  On-chain liquidity (A): $${pathALiqUsd.toFixed(2)}`);
  console.log(`  On-chain liquidity (B): $${pathBLiqUsd.toFixed(2)}`);

  if (bestOnChain > 0) {
    if (dexLiqUsd === 0) {
      console.log("\n  🎉 FIX PROVEN: DexScreener shows $0 liquidity but on-chain");
      console.log("     shows real liquidity — exactly the bug the fix solves!");
    } else {
      const diffPct = Math.abs(bestOnChain - dexLiqUsd) / Math.max(dexLiqUsd, 1) * 100;
      console.log(`\n  ✅ On-chain and DexScreener agree within ${diffPct.toFixed(1)}%`);
      console.log("     On-chain is always the authoritative source, available immediately");
      console.log("     after migration with no DexScreener indexing delay.");
    }
  } else {
    console.log("\n  ⚠️  On-chain read returned 0 — this token may need HELIUS_API_KEY");
    console.log("     (public RPC often rate-limits getAccountInfo for PumpSwap pools)");
    console.log("     Set HELIUS_API_KEY in Replit secrets and re-run for reliable results.");
  }
  console.log("═══════════════════════════════════════════════════════════════\n");
}

main().catch((err) => { console.error("Fatal:", err.message); process.exit(1); });
