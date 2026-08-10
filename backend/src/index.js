import express from "express";
import cors from "cors";
import rateLimit from "express-rate-limit";
import { paymentMiddlewareFromHTTPServer } from "@x402/express";
import { SSEServerTransport } from "@modelcontextprotocol/sdk/server/sse.js";
import { config } from "./config.js";
import { initDb } from "./db.js";
import { buildX402Server } from "./x402.js";
import { startIndexer } from "./indexer/index.js";
import { createMcpServer } from "./mcp/server.js";
import { buildMcpPaymentWrappers } from "./mcp/x402PaymentWrapper.js";
import { nftsRouter } from "./routes/nfts.js";
import { marketplaceRouter } from "./routes/marketplace.js";
import { communityRouter } from "./routes/community.js";
import { collectionsRouter } from "./routes/collections.js";
import { watchlistRouter } from "./routes/watchlist.js";
import { agentsRouter } from "./routes/agents.js";
import { activityRouter } from "./routes/activity.js";
import { startWatchdog, alertOnCrash } from "./monitoring.js";

process.on("unhandledRejection", (err) => {
  console.error("[unhandled rejection] a route threw an error without catching it:", err);
  alertOnCrash(err);
});

async function main() {
  await initDb();
  const app = express();

  app.use(
    cors({
      origin: config.cors.allowedOrigins,
    })
  );
  app.use(express.json());

  // SECURITY: baseline IP-based rate limiting across the whole API,
  // including MCP's /sse and /messages. This is a coarse defense — an
  // attacker rotating IPs bypasses it — but it stops naive volumetric
  // abuse (a single misbehaving script hammering endpoints) cheaply.
  // Real per-agent throttling would need identity tied to something
  // harder to rotate than an IP (e.g. registered wallet address checked
  // per-request), not implemented here.
  app.use(
    rateLimit({
      windowMs: 60_000,
      limit: 100,
      standardHeaders: true,
      legacyHeaders: false,
      message: { error: "Too many requests — slow down." },
    })
  );

  // A SECOND, stricter limiter layered on top of the IP-based one above —
  // keyed by agentId when present in the request body, not just IP. This
  // is a real improvement, not a complete fix: an attacker who rotates
  // BOTH IP and agentId still isn't caught by either limiter. Genuine
  // per-identity throttling that can't be rotated around would need
  // wallet-signature verification per request, a bigger change.
  const agentWriteLimiter = rateLimit({
    windowMs: 60_000,
    limit: 20,
    standardHeaders: true,
    legacyHeaders: false,
    keyGenerator: (req) => req.body?.agentId || req.ip,
    message: { error: "Too many requests from this agentId — slow down." },
  });
  app.use("/api/nfts/prepare-metadata", agentWriteLimiter);
  app.use("/api/community/post", agentWriteLimiter);
  app.use("/api/community/metadata", agentWriteLimiter);
  app.use("/api/watchlist", agentWriteLimiter);

  const x402Server = await buildX402Server();
  // The actual payment gate for REST routes. Inspects each request
  // against the "METHOD /path" keys declared in x402.js's routeConfig —
  // routes not listed there pass through untouched. MUST be mounted
  // before the routers, not after.
  app.use(paymentMiddlewareFromHTTPServer(x402Server));

  app.get("/health", (req, res) => res.json({ ok: true, environment: config.x402.environment }));

  app.use("/api/nfts", nftsRouter);
  app.use("/api/marketplace", marketplaceRouter);
  app.use("/api/community", communityRouter);
  app.use("/api/collections", collectionsRouter);
  app.use("/api/watchlist", watchlistRouter);
  app.use("/api/agents", agentsRouter);
  app.use("/api/activity", activityRouter);

  // --- MCP server, mounted over SSE ---
  // A genuinely different payment mechanism than the REST middleware
  // above — MCP tool calls all share one path, so gating happens per-tool
  // (via createMcpServer's wrapped handlers) rather than by URL matching.
  // See mcp/x402PaymentWrapper.js and mcp/server.js for the actual logic;
  // this just wires the transport. Follows Coinbase's own reference
  // pattern: https://github.com/coinbase/cdp-sdk/blob/main/examples/typescript/x402/servers/mcp/server.ts
  //
  // Each SSE connection gets its own McpServer instance (the SDK forbids
  // connecting one instance to two transports) and its own transport,
  // tracked by sessionId so POST /messages routes to the right one.
  const mcpWrappers = await buildMcpPaymentWrappers();
  const mcpTransports = new Map();
  app.get("/sse", async (req, res) => {
    const transport = new SSEServerTransport("/messages", res);
    mcpTransports.set(transport.sessionId, transport);
    res.on("close", () => mcpTransports.delete(transport.sessionId));
    await createMcpServer(mcpWrappers).connect(transport);
  });
  app.post("/messages", async (req, res) => {
    const sessionId = String(req.query.sessionId ?? "");
    const transport = mcpTransports.get(sessionId);
    if (!transport) {
      return res.status(400).json({ error: `No active SSE session for sessionId "${sessionId}"` });
    }
    await transport.handlePostMessage(req, res, req.body);
  });

  if (config.x402.environment === "production") {
    console.log("\x1b[41m\x1b[37m");
    console.log("                                                        ");
    console.log("   ⚠️  RUNNING IN PRODUCTION MODE — REAL USDC MOVES  ⚠️  ");
    console.log("   If this is your local dev machine, STOP and check   ");
    console.log("   .env's CDP_X402_SERVER_ENVIRONMENT right now.        ");
    console.log("                                                        ");
    console.log("\x1b[0m");
  }

  app.listen(config.port, () => {
    console.log(`AI NFT Marketplace backend listening on :${config.port}`);
    console.log(`  x402 environment: ${config.x402.environment}`);
    console.log(`  MCP endpoint: http://localhost:${config.port}/sse (SSE)`);
    console.log(`  MCP paid tools: browse_listings, get_nft, list_communities ($0.01 each)`);
    console.log(`  MCP free tools: register_agent, get_contract_info`);
  });

  startWatchdog();

  // RUN_INDEXER_INLINE defaults to true — unset in .env, this behaves
  // EXACTLY like tonight's build always has. Set to "false" only once
  // you're actually running backend/src/indexer-standalone.js as its
  // own separate process (e.g. multiple API server instances behind a
  // load balancer) — running it in both places at once would mean two
  // processes racing to write the same indexer_state rows.
  if (config.runIndexerInline) {
    // Deliberately not awaited — see comment below.
    startIndexer().catch((err) => {
      console.error("[indexer] failed to start:", err);
    });
  } else {
    console.log("[indexer] RUN_INDEXER_INLINE=false — not starting inline. Run indexer-standalone.js separately.");
  }
}

main().catch((err) => {
  console.error("Failed to start backend:", err);
  process.exit(1);
});