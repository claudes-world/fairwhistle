/**
 * Live TxLINE client — the production side of the FeedAdapter seam.
 *
 * Auth model (free tier): every data request carries BOTH
 *   Authorization: Bearer <guest JWT>   (from POST /auth/guest/start)
 *   X-Api-Token: <api token>            (from TXLINE_API_TOKEN env)
 * Odds snapshots require ?asOf=<now-ms> (publication window) or they return
 * an empty array. Prices arrive as decimal odds ×1000. Consensus bookmaker
 * is TXLineStablePriceDemargined (id 10021).
 *
 * This module powers /api/live: real mainnet TxLINE ingestion, honestly
 * labeled (free tier, ~60s batch delay). The demo's detection run stays on
 * the deterministic recorded fixture; this proves where the live feed plugs in.
 */

const BASE = "https://txline.txodds.com";
const CONSENSUS_BOOKMAKER_ID = 10021;

interface TxOddsRow {
  FixtureId: number;
  Ts: number;
  BookmakerId: number;
  SuperOddsType: string;
  MarketPeriod: string | null;
  MarketParameters: string | null;
  PriceNames: string[];
  Prices: number[];
}

export interface LiveMarket {
  market: string;
  outcomes: { name: string; odds: number }[];
  ts: number;
}

export interface LiveSnapshot {
  ok: true;
  fixtureId: number;
  label: string;
  source: "TxLINE mainnet (free tier, ~60s batch delay)";
  consensus: "TXLineStablePriceDemargined";
  fetchedAt: string;
  gameState: string | null;
  startTime: number | null;
  markets: LiveMarket[];
}

let jwtCache: { token: string; at: number } | null = null;

async function guestJwt(): Promise<string> {
  if (jwtCache && Date.now() - jwtCache.at < 5 * 60_000) return jwtCache.token;
  const r = await fetch(`${BASE}/auth/guest/start`, { method: "POST" });
  if (!r.ok) throw new Error(`guest auth ${r.status}`);
  const j = (await r.json()) as { token: string };
  jwtCache = { token: j.token, at: Date.now() };
  return j.token;
}

async function txGet(path: string): Promise<unknown> {
  const apiToken = process.env.TXLINE_API_TOKEN;
  if (!apiToken) throw new Error("TXLINE_API_TOKEN not configured");
  const jwt = await guestJwt();
  const r = await fetch(`${BASE}${path}`, {
    headers: { Authorization: `Bearer ${jwt}`, "X-Api-Token": apiToken },
  });
  if (!r.ok) throw new Error(`txline ${path.split("?")[0]} ${r.status}`);
  return r.json();
}

let snapCache: { data: LiveSnapshot; at: number } | null = null;

export async function liveSnapshot(): Promise<LiveSnapshot> {
  // Free tier publishes in ~60s batches — cache accordingly.
  if (snapCache && Date.now() - snapCache.at < 30_000) return snapCache.data;
  const fixtureId = Number(process.env.TXLINE_FIXTURE_ID ?? 18257739);
  const label = process.env.TXLINE_FIXTURE_LABEL ?? "FIFA World Cup Final — Spain v Argentina";

  const odds = (await txGet(`/api/odds/snapshot/${fixtureId}?asOf=${Date.now()}`)) as TxOddsRow[];
  const markets: LiveMarket[] = [];
  for (const row of odds) {
    if (row.BookmakerId !== CONSENSUS_BOOKMAKER_ID) continue;
    if (row.MarketPeriod !== null) continue; // full-time markets only
    if (row.SuperOddsType === "1X2_PARTICIPANT_RESULT") {
      markets.push({
        market: "1X2 (full time)",
        ts: row.Ts,
        outcomes: row.PriceNames.map((n, i) => ({
          name: n === "part1" ? "home" : n === "part2" ? "away" : n,
          odds: row.Prices[i] / 1000,
        })),
      });
    }
    if (row.SuperOddsType === "OVERUNDER_PARTICIPANT_GOALS" && row.MarketParameters === "line=2.5") {
      markets.push({
        market: "Over/Under 2.5",
        ts: row.Ts,
        outcomes: row.PriceNames.map((n, i) => ({ name: n, odds: row.Prices[i] / 1000 })),
      });
    }
  }

  let gameState: string | null = null;
  let startTime: number | null = null;
  try {
    const scores = (await txGet(`/api/scores/snapshot/${fixtureId}`)) as {
      GameState?: string;
      StartTime?: number;
    }[];
    if (Array.isArray(scores) && scores.length) {
      gameState = scores[scores.length - 1].GameState ?? scores[0].GameState ?? null;
      startTime = scores[0].StartTime ?? null;
    }
  } catch {
    // scores are garnish — odds alone still prove live ingestion
  }

  const data: LiveSnapshot = {
    ok: true,
    fixtureId,
    label,
    source: "TxLINE mainnet (free tier, ~60s batch delay)",
    consensus: "TXLineStablePriceDemargined",
    fetchedAt: new Date().toISOString(),
    gameState,
    startTime,
    markets,
  };
  snapCache = { data, at: Date.now() };
  return data;
}
