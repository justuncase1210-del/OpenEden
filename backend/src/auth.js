import { keccak256, toBytes, recoverMessageAddress } from "viem";
import { pool } from "./db.js";

/// Per-request wallet authentication.
///
/// An agentId is a PUBLIC string (it is listed at /api/agents), so it can
/// never be treated as a credential. Every state-changing off-chain
/// endpoint instead requires the caller to sign the request with a wallet
/// that is linked to the agent (agent_wallets table):
///
///   X-Agent-Id:  <agentId>
///   X-Timestamp: <Date.now() in ms, within AUTH_MAX_AGE_MS of server time>
///   X-Signature: personal_sign (EIP-191) over buildRequestMessage(...)
///
/// The signed message commits to the HTTP method, the full path+query and a
/// keccak256 of the raw request body, so a signature cannot be reused for a
/// different endpoint or with a tampered body. Signatures are single-use
/// (see consumeSignature) so a captured request cannot be replayed.
export const AUTH_MAX_AGE_MS = 5 * 60 * 1000;

export function hashBody(raw) {
  return keccak256(raw && raw.length ? raw : "0x");
}

export function buildRequestMessage({ agentId, method, path, timestamp, bodyHash }) {
  return [
    "OpenEden request",
    `Agent: ${agentId}`,
    `Method: ${method.toUpperCase()}`,
    `Path: ${path}`,
    `Timestamp: ${timestamp}`,
    `Body: ${bodyHash}`,
  ].join("\n");
}

function reject(res, status, error) {
  return res.status(status).json({ error, authFormat: "see get_contract_info -> requestSigning" });
}

/// Verifies the signature headers (stateless - does NOT burn the nonce, so
/// it is safe to run BEFORE the x402 payment middleware: the unpaid 402
/// response and the paid retry carry the same signature).
export async function verifyAgentSignature(req, res, next) {
  try {
    const agentId = req.get("x-agent-id");
    const timestampRaw = req.get("x-timestamp");
    const signature = req.get("x-signature");
    if (!agentId || !timestampRaw || !signature) {
      return reject(res, 401, "missing X-Agent-Id / X-Timestamp / X-Signature headers");
    }
    if (agentId.length > 64 || !/^\d{10,16}$/.test(timestampRaw) || !/^0x[0-9a-fA-F]{130}$/.test(signature)) {
      return reject(res, 401, "malformed auth headers");
    }
    const timestamp = Number(timestampRaw);
    const age = Date.now() - timestamp;
    if (age < -30_000 || age > AUTH_MAX_AGE_MS) {
      return reject(res, 401, `X-Timestamp is stale or in the future (must be within ${AUTH_MAX_AGE_MS / 1000}s)`);
    }

    const message = buildRequestMessage({
      agentId,
      method: req.method,
      path: req.originalUrl,
      timestamp: timestampRaw,
      bodyHash: hashBody(req.rawBody),
    });

    let signer;
    try {
      signer = (await recoverMessageAddress({ message, signature })).toLowerCase();
    } catch {
      return reject(res, 401, "signature could not be verified");
    }

    const { rows } = await pool.query(
      "SELECT 1 FROM agent_wallets WHERE wallet_address = $1 AND agent_id = $2",
      [signer, agentId]
    );
    if (rows.length === 0) {
      return reject(res, 403, "signer is not a wallet linked to this agentId");
    }

    req.agentAuth = { agentId, wallet: signer, sigHash: keccak256(toBytes(signature.toLowerCase())) };
    next();
  } catch (err) {
    next(err);
  }
}

/// Burns the signature so it can never be accepted twice. Mounted at the
/// ROUTER level, i.e. only reached once payment (if any) has cleared.
let lastCleanup = 0;
export async function consumeSignature(req, res, next) {
  try {
    if (!req.agentAuth) return reject(res, 401, "unauthenticated");
    const { rowCount } = await pool.query(
      `INSERT INTO used_signatures (sig_hash, expires_at) VALUES ($1, now() + interval '10 minutes')
       ON CONFLICT DO NOTHING`,
      [req.agentAuth.sigHash]
    );
    if (rowCount === 0) return reject(res, 401, "signature already used - sign a fresh request");

    if (Date.now() - lastCleanup > 60_000) {
      lastCleanup = Date.now();
      pool.query("DELETE FROM used_signatures WHERE expires_at < now()").catch(() => {});
    }
    next();
  } catch (err) {
    next(err);
  }
}

/// Registration-time messages (signed by wallets, not HTTP requests).
export function buildLinkAuthorizationMessage({ agentId, newWalletAddress, timestamp }) {
  return `Authorize linking a new wallet to an OpenEden agent.\nAgent: ${agentId}\nNew wallet: ${newWalletAddress}\nTimestamp: ${timestamp}`;
}
