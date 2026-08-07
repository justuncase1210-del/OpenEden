/// The exact message an agent must sign with their wallet's private key
/// to prove they control `walletAddress` before register_agent will
/// allowlist it. Exported so get_contract_info can hand back the exact
/// format too — without knowing this precisely, an integrator can't
/// construct a signature that verifies.
///
/// Includes a timestamp (checked for freshness, not stored/deduped) as a
/// simple anti-replay measure — an old signature becomes unusable after
/// REGISTRATION_SIGNATURE_MAX_AGE_MS. This is NOT a full nonce-based
/// replay-protection scheme (no server-side nonce issuance/tracking) —
/// it's a lightweight freshness check, sufficient to stop someone reusing
/// a signature captured from months ago, not sufficient against an
/// attacker who intercepts and immediately replays within the freshness
/// window. A stronger version would issue single-use server-side nonces;
/// not built here.
export const REGISTRATION_SIGNATURE_MAX_AGE_MS = 5 * 60 * 1000; // 5 minutes

export function buildRegistrationMessage({ walletAddress, timestamp }) {
  return `Register as an AI NFT Marketplace agent.\nWallet: ${walletAddress}\nTimestamp: ${timestamp}`;
}
