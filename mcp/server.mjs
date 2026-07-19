#!/usr/bin/env node
// FairWhistle MCP server — a thin stdio wrapper around FairWhistle's existing
// public read-only HTTP endpoints (/api/alerts, /api/live-state, /api/meta,
// /api/verify, /api/state). It adds no new detection or attestation logic:
// every tool call is a fetch() against a running FairWhistle deployment
// (default: the production demo) plus a light, honestly-described reshape of
// the JSON that endpoint already returns. See README.md and public/docs.html
// in the repo root for the full response shapes.
//
// Run standalone:
//   node mcp/server.mjs
// Point at a different deployment (e.g. a local `pnpm dev`) with:
//   FAIRWHISTLE_BASE_URL=http://localhost:3000 node mcp/server.mjs

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

const BASE_URL = (process.env.FAIRWHISTLE_BASE_URL || "https://fairwhistle.vercel.app").replace(/\/+$/, "");

const REPLAY_NOTE =
  "replay is a labeled SYNTHETIC FIXTURE — a deterministic, seeded, openly-labeled " +
  "replayed tape with 3 planted integrity anomalies. It is always available and " +
  "useful for exercising the tool mechanics, but it is not real market data.";
const LIVE_NOTE =
  "live watches the REAL FIFA World Cup Final via TxLINE mainnet consensus odds " +
  "(free tier: single consensus bookmaker, ~60s batch delay — informative, not " +
  "execution-grade latency). If the deployment has no TXLINE_API_TOKEN configured, " +
  "the underlying endpoint returns HTTP 503 with an honest reason, and this tool " +
  "surfaces that as a clear, structured 'unavailable' result — not a crash, and " +
  "not something to retry aggressively.";

const OUTCOME_LABEL = {
  h: "1X2 · Home",
  d: "1X2 · Draw",
  a: "1X2 · Away",
  o: "Totals 2.5 · Over",
  u: "Totals 2.5 · Under",
};

async function getJson(path) {
  const url = `${BASE_URL}${path}`;
  let res;
  try {
    res = await fetch(url);
  } catch (e) {
    throw new Error(`request to ${url} failed: ${e.message || e}`);
  }
  const text = await res.text();
  let body;
  try {
    body = text ? JSON.parse(text) : {};
  } catch {
    throw new Error(`non-JSON response from ${url} (status ${res.status}): ${text.slice(0, 300)}`);
  }
  return { status: res.status, ok: res.ok, body };
}

async function postJson(path, payload) {
  const url = `${BASE_URL}${path}`;
  let res;
  try {
    res = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload),
    });
  } catch (e) {
    throw new Error(`request to ${url} failed: ${e.message || e}`);
  }
  const text = await res.text();
  let body;
  try {
    body = text ? JSON.parse(text) : {};
  } catch {
    throw new Error(`non-JSON response from ${url} (status ${res.status}): ${text.slice(0, 300)}`);
  }
  return { status: res.status, ok: res.ok, body };
}

function textResult(value) {
  return { content: [{ type: "text", text: JSON.stringify(value, null, 2) }] };
}

function errorResult(err) {
  return {
    content: [{ type: "text", text: `FairWhistle request failed: ${err.message || err}` }],
    isError: true,
  };
}

/** Drop the bulky evidence chart series by default; keep window/params so the
 * shape and rule are still legible. Full series available via includeEvidence
 * or by calling the raw endpoint directly. */
function trimAlert(alert, includeEvidence) {
  if (includeEvidence || !alert.evidence) return alert;
  const { series, zSeries, ...rest } = alert.evidence;
  return {
    ...alert,
    evidence: {
      ...rest,
      seriesOmitted: Array.isArray(series) ? series.length : 0,
      note: "full evidence chart series omitted for brevity — pass includeEvidence:true, or fetch /api/alerts or /api/live-state directly, for the raw series.",
    },
  };
}

const sourceSchema = z
  .enum(["replay", "live"])
  .default("replay")
  .describe(`Which surveillance feed. replay (default): ${REPLAY_NOTE} live: ${LIVE_NOTE}`);

/** Fetch the current alert list for a source, normalized to one shape.
 * Returns { available, honestyNote, generatedAt, agentPubKey, alerts, unavailable? }. */
async function fetchAlerts(source) {
  if (source === "live") {
    const { status, ok, body } = await getJson("/api/live-state");
    if (status === 503 || !ok) {
      return {
        available: false,
        reason: body.reason || `HTTP ${status}`,
        note: body.note || "live surveillance is unavailable on this deployment — expected when no TXLINE_API_TOKEN is configured, not a bug.",
      };
    }
    return {
      available: true,
      honestyNote: body.honesty,
      generatedAt: body.fetchedAt,
      agentPubKey: body.agentPubKey,
      fixtureLabel: body.label,
      gameState: body.gameState,
      alerts: body.alerts || [],
    };
  }
  const { status, ok, body } = await getJson("/api/alerts");
  if (!ok) throw new Error(`GET /api/alerts -> HTTP ${status}: ${JSON.stringify(body).slice(0, 300)}`);
  return {
    available: true,
    honestyNote: body.syntheticNote,
    generatedAt: body.generatedAt,
    agentPubKey: body.agentPubKey,
    fixtureId: body.fixtureId,
    alerts: body.alerts || [],
  };
}

const server = new McpServer({
  name: "fairwhistle",
  version: "1.0.0",
  title: "FairWhistle — match-integrity surveillance agent's risk desk",
});

server.registerTool(
  "list_active_alerts",
  {
    title: "List active integrity alerts",
    description:
      "Current attested integrity alerts from FairWhistle's surveillance agent — " +
      "timestamped, hashed, Ed25519-signed detections of odds-microstructure patterns " +
      "consistent with fixing or informed money (abnormal velocity, coordinated " +
      "cross-market moves, stale-then-snap repricing). Wraps GET /api/alerts (replay) " +
      "or GET /api/live-state (live), no new detection logic. " +
      `${REPLAY_NOTE} ${LIVE_NOTE} ` +
      "Use this for a full sweep; use check_market_integrity when you already know " +
      "which outcome you're about to trade.",
    inputSchema: {
      source: sourceSchema,
      severity: z
        .enum(["high", "critical"])
        .optional()
        .describe("Optional filter: only return alerts at this severity."),
      includeEvidence: z
        .boolean()
        .optional()
        .describe("Include the full evidence chart series (odds points, z-scores) per alert. Default false — series are large and usually not needed to decide whether to trade."),
    },
  },
  async ({ source, severity, includeEvidence }) => {
    try {
      const data = await fetchAlerts(source);
      if (!data.available) {
        return textResult({ source, available: false, reason: data.reason, note: data.note });
      }
      let alerts = data.alerts;
      if (severity) alerts = alerts.filter((a) => a.severity === severity);
      alerts = alerts.map((a) => trimAlert(a, includeEvidence));
      return textResult({
        source,
        available: true,
        honestyNote: data.honestyNote,
        generatedAt: data.generatedAt,
        agentPubKey: data.agentPubKey,
        alertCount: alerts.length,
        alerts,
      });
    } catch (e) {
      return errorResult(e);
    }
  }
);

server.registerTool(
  "get_market_status",
  {
    title: "Get current match / feed status",
    description:
      "Current surveillance-feed status. In replay: the current replay cycle/tick, " +
      "match minute, and score (derived from the same occurred-events log the dashboard " +
      "uses — counting goal events per team up to the current tick). In live: the real " +
      "TxLINE fixture label, feed game-state string (e.g. 'scheduled', 'H1', 'HT'), and " +
      "kickoff time. Wraps GET /api/state (replay) or GET /api/live-state (live), no new " +
      `logic. ${REPLAY_NOTE} ${LIVE_NOTE}`,
    inputSchema: { source: sourceSchema },
  },
  async ({ source }) => {
    try {
      if (source === "live") {
        // sinceTs near "now" so the (potentially thousands-long) points series
        // is trimmed to ~nothing; status doesn't need the tick-by-tick history.
        const { status, ok, body } = await getJson(`/api/live-state?sinceTs=${Date.now()}`);
        if (status === 503 || !ok) {
          return textResult({
            source,
            available: false,
            reason: body.reason || `HTTP ${status}`,
            note: body.note || "live surveillance is unavailable on this deployment — expected when no TXLINE_API_TOKEN is configured, not a bug.",
          });
        }
        return textResult({
          source,
          available: true,
          fixtureId: body.fixtureId,
          fixtureLabel: body.label,
          gameState: body.gameState,
          kickoffMs: body.startTime,
          fetchedAt: body.fetchedAt,
          activeAlertCount: (body.alerts || []).length,
          honestyNote: body.honesty,
        });
      }
      const { status, ok, body } = await getJson("/api/state?since=10000");
      if (!ok) throw new Error(`GET /api/state -> HTTP ${status}`);
      let home = 0;
      let away = 0;
      const events = [];
      for (const e of body.events || []) {
        if (!e.occurred) continue;
        if (e.type === "goal") e.team === "home" ? home++ : away++;
        events.push({ type: e.type, team: e.team, label: e.label });
      }
      return textResult({
        source,
        available: true,
        fixtureId: body.meta.fixtureId,
        match: body.meta.match,
        cycle: body.now.cycle,
        tick: body.now.tick,
        matchMinute: body.now.matchMinute,
        wallIso: body.now.wallIso,
        score: { home, away },
        occurredEvents: events,
        activeAlertCount: (body.alerts || []).length,
        replayLoop: `${body.meta.ticks} ticks per ${body.meta.cycleMs / 1000}s cycle, deterministic — same tick offset always yields the same detections`,
        honestyNote: body.meta.syntheticNote,
      });
    } catch (e) {
      return errorResult(e);
    }
  }
);

server.registerTool(
  "check_market_integrity",
  {
    title: "Check whether a market is flagged before trading it",
    description:
      "The 'should I trade this' tool — an agent's pre-trade risk check. Filters " +
      "FairWhistle's currently active attested alerts down to the ones touching a " +
      "specific outcome (1X2 home/draw/away or totals over/under 2.5) and returns a " +
      "clear verdict: 'clean' (no active alert touches this outcome) or 'flagged' " +
      "(one or more do, listed with headline/narrative/severity/rule so the caller can " +
      "judge for itself — this tool does not decide FOR you whether to trade, it " +
      `surfaces the evidence). Built on the same data as list_active_alerts. ${REPLAY_NOTE} ${LIVE_NOTE}`,
    inputSchema: {
      market: z.enum(["h", "d", "a", "o", "u"]).describe(
        "Outcome to check: h=1X2 home, d=1X2 draw, a=1X2 away, o=totals 2.5 over, u=totals 2.5 under."
      ),
      source: sourceSchema,
    },
  },
  async ({ market, source }) => {
    try {
      const data = await fetchAlerts(source);
      if (!data.available) {
        return textResult({
          source,
          market,
          marketLabel: OUTCOME_LABEL[market],
          verdict: "unavailable",
          reason: data.reason,
          note: data.note,
        });
      }
      const matching = data.alerts
        .filter((a) => (a.core.outcomes || []).includes(market))
        .map((a) => trimAlert(a, false));
      return textResult({
        source,
        market,
        marketLabel: OUTCOME_LABEL[market],
        verdict: matching.length ? "flagged" : "clean",
        asOf: data.generatedAt,
        matchingAlertCount: matching.length,
        alerts: matching,
        honestyNote: data.honestyNote,
      });
    } catch (e) {
      return errorResult(e);
    }
  }
);

server.registerTool(
  "verify_alert_signature",
  {
    title: "Verify an alert's Ed25519 signature",
    description:
      "Independently verifies that a FairWhistle alert's signature is genuine and the " +
      "instance hasn't been tampered with — wraps POST /api/verify (or GET /api/verify?id= " +
      "for a replay-cycle alert looked up by id). Two ways to call it: (1) pass alertId " +
      "for a REPLAY alert (the server looks up that alert's current-cycle instance itself — " +
      "replay only, since live alerts aren't cycle-indexed server-side); or (2) pass the " +
      "exact instance object + signature (+ optionally publicKey, defaulting to " +
      "instance.agentPubKey) copied from an alert returned by list_active_alerts or " +
      "check_market_integrity — this path works for both replay and live alerts. " +
      "Returns { valid: true|false, instanceHash }.",
    inputSchema: {
      source: sourceSchema,
      alertId: z.string().optional().describe("Replay-only: an alert's short id (e.g. from list_active_alerts). Looks up that alert's signed instance for the current cycle via GET /api/verify?id="),
      instance: z
        .record(z.string(), z.unknown())
        .optional()
        .describe("The alert's `instance` object (coreHash, cycle/detectedAt or signedAt, agentPubKey) — required if not using alertId."),
      signature: z.string().optional().describe("The alert's hex Ed25519 `signature` — required if not using alertId."),
      publicKey: z.string().optional().describe("Hex Ed25519 public key to verify against. Defaults to instance.agentPubKey if omitted."),
    },
  },
  async ({ source, alertId, instance, signature, publicKey }) => {
    try {
      if (alertId) {
        if (source === "live") {
          return errorResult(new Error("alertId lookup only works for source=replay (GET /api/verify?id= searches replay-cycle alerts only). Pass instance+signature for a live alert instead."));
        }
        const { status, ok, body } = await getJson(`/api/verify?id=${encodeURIComponent(alertId)}`);
        if (!ok) return textResult({ ok: false, status, ...body });
        return textResult(body);
      }
      if (!instance || !signature) {
        return errorResult(new Error("provide either alertId (replay only) or both instance and signature (copied from an alert's fields — see check_market_integrity / list_active_alerts output)."));
      }
      const pubKey = publicKey || instance.agentPubKey;
      if (!pubKey) return errorResult(new Error("no publicKey given and instance.agentPubKey is missing — pass publicKey explicitly."));
      const { status, ok, body } = await postJson("/api/verify", { instance, signature, publicKey: pubKey });
      if (!ok) return textResult({ ok: false, status, ...body });
      return textResult(body);
    } catch (e) {
      return errorResult(e);
    }
  }
);

const transport = new StdioServerTransport();
await server.connect(transport);
