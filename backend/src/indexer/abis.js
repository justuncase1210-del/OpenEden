/// Event-only ABI fragments — just enough for the indexer to decode logs
/// and, for community events, resolve a slugHash back to its raw slug
/// (see communitiesRead below). Function ABIs used for writing live in
/// chain/*.js; these are read/watch-only.

export const AGENT_NFT_EVENTS_ABI = [
  {
    type: "event",
    name: "CollectionCreated",
    inputs: [
      { name: "collectionId", type: "uint256", indexed: true },
      { name: "creator", type: "address", indexed: true },
      { name: "creatorAgentId", type: "string", indexed: false },
      { name: "maxSupply", type: "uint256", indexed: false },
    ],
  },
  {
    type: "event",
    name: "MintEnded",
    inputs: [{ name: "collectionId", type: "uint256", indexed: true }],
  },
  {
    type: "event",
    name: "MintPriceUpdated",
    inputs: [
      { name: "collectionId", type: "uint256", indexed: true },
      { name: "priceUsdc", type: "uint256", indexed: false },
    ],
  },
  {
    type: "event",
    name: "Minted",
    inputs: [
      { name: "tokenId", type: "uint256", indexed: true },
      { name: "collectionId", type: "uint256", indexed: true },
      { name: "to", type: "address", indexed: true },
      { name: "agentId", type: "string", indexed: false },
      { name: "tokenURI", type: "string", indexed: false },
    ],
  },
];

export const MARKETPLACE_EVENTS_ABI = [
  {
    type: "event",
    name: "Listed",
    inputs: [
      { name: "listingId", type: "uint256", indexed: true },
      { name: "seller", type: "address", indexed: true },
      { name: "tokenId", type: "uint256", indexed: false },
      { name: "price", type: "uint256", indexed: false },
    ],
  },
  {
    type: "event",
    name: "Sold",
    inputs: [
      { name: "listingId", type: "uint256", indexed: true },
      { name: "buyer", type: "address", indexed: true },
      { name: "price", type: "uint256", indexed: false },
    ],
  },
  {
    type: "event",
    name: "Cancelled",
    inputs: [{ name: "listingId", type: "uint256", indexed: true }],
  },
];

export const COMMUNITY_REGISTRY_EVENTS_ABI = [
  {
    type: "event",
    name: "CommunityCreated",
    inputs: [
      { name: "slugHash", type: "bytes32", indexed: true },
      { name: "slug", type: "string", indexed: false },
      { name: "creator", type: "address", indexed: true },
      { name: "creatorAgentId", type: "string", indexed: false },
    ],
  },
  {
    type: "event",
    name: "MemberJoined",
    inputs: [
      { name: "slugHash", type: "bytes32", indexed: true },
      { name: "member", type: "address", indexed: true },
    ],
  },
  {
    type: "event",
    name: "MemberLeft",
    inputs: [
      { name: "slugHash", type: "bytes32", indexed: true },
      { name: "member", type: "address", indexed: true },
    ],
  },
  // MemberJoined/MemberLeft only carry slugHash, not the raw slug — this
  // read function resolves slugHash -> slug via the contract's own public
  // `communities` mapping getter, since Postgres is keyed by slug (text),
  // not slugHash. One extra RPC read per join/leave event; fine for a
  // scaffold, worth caching slugHash->slug locally (built from
  // CommunityCreated events as they're seen) if this becomes a bottleneck.
  {
    type: "function",
    name: "communities",
    stateMutability: "view",
    inputs: [{ name: "", type: "bytes32" }],
    outputs: [
      { name: "slug", type: "string" },
      { name: "creator", type: "address" },
      { name: "creatorAgentId", type: "string" },
      { name: "createdAt", type: "uint256" },
    ],
  },
];

export const OFFERS_EVENTS_ABI = [
  {
    type: "event",
    name: "OfferMade",
    inputs: [
      { name: "offerId", type: "uint256", indexed: true },
      { name: "offerer", type: "address", indexed: true },
      { name: "tokenId", type: "uint256", indexed: true },
      { name: "amount", type: "uint256", indexed: false },
      { name: "expiresAt", type: "uint256", indexed: false },
    ],
  },
  {
    type: "event",
    name: "OfferCancelled",
    inputs: [{ name: "offerId", type: "uint256", indexed: true }],
  },
  {
    type: "event",
    name: "OfferAccepted",
    inputs: [
      { name: "offerId", type: "uint256", indexed: true },
      { name: "accepter", type: "address", indexed: true },
      { name: "amount", type: "uint256", indexed: false },
    ],
  },
  // OfferAccepted doesn't carry tokenId (Offers.sol's event signature
  // omits it, already indexed at OfferMade) — this read function
  // resolves offerId -> tokenId from the contract's own public `offers`
  // mapping getter, mirroring the slugHash->slug pattern above.
  {
    type: "function",
    name: "offers",
    stateMutability: "view",
    inputs: [{ name: "", type: "uint256" }],
    outputs: [
      { name: "offerer", type: "address" },
      { name: "tokenId", type: "uint256" },
      { name: "amount", type: "uint256" },
      { name: "expiresAt", type: "uint256" },
      { name: "active", type: "bool" },
    ],
  },
];