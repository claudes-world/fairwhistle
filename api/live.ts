import type { VercelRequest, VercelResponse } from "@vercel/node";
import { liveSnapshot } from "../src/txline.js";

/**
 * Live TxLINE ingestion proof: real mainnet consensus odds for the configured
 * fixture (default: today's World Cup Final), fetched through the same
 * adapter seam the detectors would consume in production. Returns 503 with a
 * plain explanation when no credentials are configured (e.g. a fresh clone) —
 * the demo never fakes liveness.
 */
export default async function handler(_req: VercelRequest, res: VercelResponse) {
  res.setHeader("Cache-Control", "no-store");
  res.setHeader("Access-Control-Allow-Origin", "*");
  try {
    res.status(200).json(await liveSnapshot());
  } catch (e) {
    res.status(503).json({
      ok: false,
      reason: String(e instanceof Error ? e.message : e),
      note: "Live TxLINE mode needs TXLINE_API_TOKEN. The demo's detection run uses the deterministic recorded fixture either way.",
    });
  }
}
