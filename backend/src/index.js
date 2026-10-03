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
import { uploadsRouter } from "./routes/uploads.js";
import { ALLOWED_IMAGE_TYPES, MAX_IMAGE_BYTES } from "./profile.js";
import { marketplaceRouter } from "./routes/marketplace.js";
import { communityRouter } from "./routes/community.js";
import { collectionsRouter } from "./routes/collections.js";
import { watchlistRouter } from "./routes/watchlist.js";
import { agentsRouter } from "./routes/agents.js";
import { activityRouter } from "./routes/activity.js";
import { startWatchdog, alertOnCrash } from "./monitoring.js";
import { verifyAgentSignature } from "./auth.js";

process.on("unhandledRejection", (err) => {
  console.error("[unhandled rejection] a route threw an error without catching it:", err);
  alertOnCrash(err);
});

async function main() {
  await initDb();
  const app = express();
  // Behind Render's proxy every request would otherwise share ONE ip
  // (the proxy's), putting all users in a single rate-limit bucket.
  app.set("trust proxy", config.trustProxy);
  app.disable("x-powered-by");
  app.use((req, res, next) => {
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("X-Frame-Options", "DENY");
    res.setHeader("Referrer-Policy", "no-referrer");
    res.setHeader("Strict-Transport-Security", "max-age=15552000; includeSubDomains");
    next();
  });

  // Vercel generates a NEW hash-based URL on every single deployment
  // (<project>-<hash>-<team>.vercel.app) - listing exact strings in
  // ALLOWED_ORIGINS would break on every future deploy. Instead: allow
  // the stable custom domain/localhost entries from ALLOWED_ORIGINS
  // exactly, PLUS any URL matching this project's Vercel deployment
  // pattern via regex, so future deployments work without ever
  // touching this config again.
  const originRegex = config.cors.originPattern ? new RegExp(`^https://(?:${config.cors.originPattern})$`) : null;
  app.use(
    cors({
      origin: (origin, callback) => {
        if (!origin) return callback(null, true); // non-browser requests (curl, agents) have no Origin header at all
        if (config.cors.allowedOrigins.includes(origin) || (originRegex && originRegex.test(origin))) {
          return callback(null, true);
        }
        return callback(new Error(`Origin ${origin} not allowed by CORS`));
      },
    })
  );
  // rawBody is captured so request signatures can commit to the exact bytes sent (auth.js).
  app.use(express.json({ limit: "100kb", verify: (req, res, buf) => { req.rawBody = buf; } }));

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
    // Keyed on the VERIFIED agent (signature checked above), never a caller-supplied
    // string - so it can neither be rotated around nor used to lock a victim out.
    keyGenerator: (req) => req.agentAuth?.agentId || req.ip,
    message: { error: "Too many requests from this agentId — slow down." },
  });
  // Image uploads send raw bytes, so this one route needs the raw-body parser BEFORE signature
  // verification (the signature commits to a hash of exactly these bytes).
  if (config.uploads.enabled) {
    app.post(
      "/api/uploads/image",
      (req, res, next) => {
        // Refuse unsupported types BEFORE signature checking: the raw-body parser below only reads
        // allowed types, so anything else would otherwise fail later with a confusing 403.
        const ct = (req.get("content-type") || "").split(";")[0].trim().toLowerCase();
        if (!ALLOWED_IMAGE_TYPES.includes(ct)) return res.status(415).json({ error: `Content-Type must be one of: ${ALLOWED_IMAGE_TYPES.join(", ")} (SVG is not accepted)` });
        next();
      },
      express.raw({ type: ALLOWED_IMAGE_TYPES, limit: MAX_IMAGE_BYTES, verify: (req, res, buf) => { req.rawBody = buf; } }),
      verifyAgentSignature
    );
  }
  // Wallet-signature auth for every state-changing off-chain endpoint. Runs
  // BEFORE the limiter and the x402 payment gate; the nonce is only burned
  // later, at router level, so the 402 -> paid retry can reuse the signature.
  for (const [method, path] of [
    ["post", "/api/nfts/prepare-metadata"],
    ["post", "/api/nfts/:tokenId/community"],
    ["post", "/api/community/metadata"],
    ["post", "/api/community/post"],
    ["post", "/api/collections/:id/profile"],
    ["post", "/api/watchlist"],
    ["delete", "/api/watchlist/:id"],
  ]) {
    app[method](path, verifyAgentSignature);
  }
  app.use("/api/nfts/prepare-metadata", agentWriteLimiter);
  if (config.uploads.enabled) app.use("/api/uploads", agentWriteLimiter);
  app.use("/api/collections/:id/profile", agentWriteLimiter);
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
  // Exposes the same contract addresses get_contract_info returns via
  // MCP, but as a plain REST endpoint - lets the /create documentation
  // page (and anything else) show live, always-current addresses
  // instead of ones that go stale the next time contracts redeploy.
  app.get("/api/contract-info", (req, res) => {
    res.json({
      chainId: config.chain.chainId,
      agentRegistryAddress: config.chain.agentRegistryAddress,
      nftContractAddress: config.chain.nftContractAddress,
      marketplaceContractAddress: config.chain.marketplaceContractAddress,
      offersContractAddress: config.chain.offersContractAddress,
      communityRegistryAddress: config.chain.communityRegistryAddress,
      // Base Sepolia's official USDC address - fixed, not part of your
      // own deployment, so it isn't in config.js alongside the others.
      usdcAddress: config.chain.usdcAddress,
    });
  });
  // Express 4 never catches a rejected async handler (the request just hangs).
  const wrapAsync = (router) => {
    for (const layer of router.stack) {
      if (!layer.route) continue;
      for (const l of layer.route.stack) {
        const fn = l.handle;
        l.handle = (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
      }
    }
    return router;
  };
  [nftsRouter, uploadsRouter, marketplaceRouter, communityRouter, collectionsRouter, watchlistRouter, agentsRouter, activityRouter].forEach(wrapAsync);
  // ERC-7572 contractURI target for the AgentNFT contract as a whole (owner sets it on-chain with
  // setContractURI). Per-collection names/images live in each collection's profile instead.
  app.get("/api/contract-metadata", (req, res) => {
    const siteUrl = config.platform.siteUrl || config.cors.allowedOrigins.find((o) => o.startsWith("https://")) || "";
    res.json({
      name: config.platform.name,
      description: config.platform.description,
      ...(config.platform.imageUrl && { image: config.platform.imageUrl }),
      ...(siteUrl && { external_link: siteUrl }),
    });
  });
  app.use("/api/nfts", nftsRouter);
  if (config.uploads.enabled) app.use("/api/uploads", uploadsRouter);
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
  const sseByIp = new Map();
  app.get("/sse", async (req, res) => {
    const ip = req.ip;
    if (mcpTransports.size >= config.sse.maxConnections || (sseByIp.get(ip) || 0) >= config.sse.maxPerIp) {
      return res.status(429).json({ error: "too many open MCP connections" });
    }
    sseByIp.set(ip, (sseByIp.get(ip) || 0) + 1);
    const lifetime = setTimeout(() => res.end(), config.sse.maxLifetimeMs);
    res.on("close", () => {
      clearTimeout(lifetime);
      const n = (sseByIp.get(ip) || 1) - 1;
      if (n <= 0) sseByIp.delete(ip); else sseByIp.set(ip, n);
    });
    const transport = new SSEServerTransport("/messages", res);
    mcpTransports.set(transport.sessionId, transport);
    res.on("close", () => mcpTransports.delete(transport.sessionId));
    await createMcpServer(mcpWrappers, { clientIp: req.ip }).connect(transport);
  });
  app.post("/messages", async (req, res) => {
    const sessionId = String(req.query.sessionId ?? "");
    const transport = mcpTransports.get(sessionId);
    if (!transport) {
      return res.status(400).json({ error: `No active SSE session for sessionId "${sessionId}"` });
    }
    await transport.handlePostMessage(req, res, req.body);
  });

  // eslint-disable-next-line no-unused-vars
  app.use((err, req, res, next) => {
    if (err?.type === "entity.parse.failed") return res.status(400).json({ error: "invalid JSON body" });
    if (err?.type === "entity.too.large") return res.status(413).json({ error: "request body too large" });
    if (err?.message?.startsWith("Origin ")) return res.status(403).json({ error: "origin not allowed" });
    console.error("[error]", req.method, req.originalUrl, err);
    if (res.headersSent) return;
    res.status(500).json({ error: "internal server error" });
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