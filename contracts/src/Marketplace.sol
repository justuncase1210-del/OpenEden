// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IERC721} from "@openzeppelin/contracts/token/ERC721/IERC721.sol";
import {IERC2981} from "@openzeppelin/contracts/interfaces/IERC2981.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {Pausable} from "@openzeppelin/contracts/utils/Pausable.sol";
import {AgentRegistry} from "./AgentRegistry.sol";

/// @notice Minimal interface for the AgentNFT functions Marketplace needs
///         to call back into — kept separate from a full import to avoid
///         a circular Solidity import (AgentNFT doesn't need to know
///         about Marketplace's full interface, just these calls).
interface IAgentNFTListingTracker {
    function setActiveListing(uint256 tokenId, uint256 listingId) external;
    function tokenCollectionId(uint256 tokenId) external view returns (uint256);
    function isCollectionMintEnded(uint256 collectionId) external view returns (bool);
}

/// @title Marketplace
/// @notice Fixed-price listing/buying escrow for the AgentNFT collection,
///         priced in USDC on Base (matches the rest of the stack's x402
///         USDC-only payment rail, so agents don't need to hold ETH beyond
///         gas). NOT an auction house — no bidding, no Dutch auctions.
///         That's a real feature gap vs OpenSea if you want it later.
/// @dev RESTRICTED TO A SINGLE ERC721 CONTRACT (AgentNFT), deliberately —
///      not a general multi-contract marketplace. This was a real fork:
///      the alternative (accept any ERC721 address in `list()`) is more
///      OpenSea-like, but makes `AgentNFT.activeListingId` tracking
///      impossible to wire up generically (an arbitrary external NFT
///      contract won't implement `setActiveListing`). Restricting to one
///      contract was chosen because it matches this project's actual
///      scope — an agent-only marketplace for agent-*created* NFTs, not a
///      general aggregator. (Separately, AgentNFT itself now hosts many
///      independent agent-created COLLECTIONS internally — a different,
///      unrelated concept from "which contract Marketplace trades." See
///      AgentNFT.sol's Collection struct.)
/// @dev Sellers must `approve` this contract for their tokenId (or
///      `setApprovalForAll`) before calling `list`. This contract holds
///      the NFT in escrow once listed (transferred in on `list`, out on
///      `buy` or `cancelListing`) rather than using a signature-based
///      "list without transferring" pattern like Seaport — simpler to
///      reason about, but means listing costs gas. Flag if you want a
///      Seaport-style gasless-listing approach instead; that's a bigger
///      rewrite (order structs + EIP-712 signatures + a real settlement
///      engine) and worth doing deliberately, not as a first pass.
/// @dev AGENT-ONLY IS HARD-ENFORCED ON-CHAIN via AgentRegistry. `list`
///      and `buy` both require msg.sender to be a registered agent wallet —
///      a random wallet calling either directly (bypassing the API
///      entirely) hits a revert, not just "no UI for it." Humans can
///      still freely READ all marketplace state (listings mapping,
///      events) — nothing here restricts observation, only the two
///      state-changing calls that constitute "buying/selling/participating."
///      `cancelListing` is deliberately NOT gated — see its own comment.
contract Marketplace is ReentrancyGuard, Ownable, Pausable {
    struct Listing {
        address seller;
        uint256 tokenId;
        uint256 price; // in USDC base units (6 decimals)
        bool active;
    }

    IERC20 public immutable usdc;
    AgentRegistry public immutable agentRegistry;
    IERC721 public immutable agentNFT;
    uint256 public nextListingId = 1;
    mapping(uint256 => Listing) public listings;

    /// @notice Marketplace fee in basis points (e.g. 250 = 2.5%), taken from
    ///         the sale price on top of any ERC-2981 creator royalty.
    ///         Capped at MAX_FEE_BPS — see setFee()'s comment for why.
    uint96 public constant MAX_FEE_BPS = 2000; // 20%
    uint96 public feeBps = 250;
    address public feeRecipient;

    event Listed(uint256 indexed listingId, address indexed seller, uint256 tokenId, uint256 price);
    event Sold(uint256 indexed listingId, address indexed buyer, uint256 price);
    event Cancelled(uint256 indexed listingId);
    event FeeUpdated(uint96 feeBps, address feeRecipient);
    event EmergencyWithdrawal(address indexed asset, address indexed to, uint256 tokenIdOrAmount);

    error NotSeller();
    error NotActive();
    error PriceZero();
    error NotAgent();
    error ListTooSoon();
    error MintNotEnded();
    error DailyActionLimitReached();
    error FeeTooHigh();
    error NotOffersContract();

    /// @notice Minimum time between listings, per agent wallet. Same
    ///         anti-spam reasoning as AgentNFT's MIN_MINT_INTERVAL —
    ///         listing costs only gas, nothing else discourages flooding
    ///         the marketplace with junk listings. NOT applied to `buy`
    ///         (a real purchase already costs real USDC every time —
    ///         self-limiting) or `cancelListing` (an agent should be able
    ///         to immediately reclaim a mistaken listing without waiting
    ///         out a cooldown).
    uint256 public constant MIN_LIST_INTERVAL = 10 seconds;
    mapping(address => uint256) public lastListAt;

    /// @notice Max combined `list()` + `buy()` + Offers.sol's
    ///         `makeOffer()`/`acceptOffer()` calls per agent per calendar
    ///         day — ONE shared counter across both contracts, not 10 of
    ///         each. Per explicit request: "list or buy or sell 10 times
    ///         a day." `sell` isn't its own on-chain action (a sale
    ///         happens when someone ELSE calls `buy()`/`acceptOffer()`
    ///         against your listing/offer) — covered by this same cap.
    ///         NOT applied to `cancelListing` or `Offers.cancelOffer()`,
    ///         same "always allow exit" reasoning throughout this system.
    ///         Same fixed-window caveat as AgentNFT's weekly collection
    ///         cap — see that comment for the boundary-case tradeoff.
    uint256 public constant MAX_DAILY_ACTIONS = 10;
    mapping(address => uint256) public dailyActionCount;
    mapping(address => uint256) public dailyActionWindowIndex;

    /// @notice The Offers contract, authorized to consume from the SAME
    ///         daily counter above via consumeDailyAction() below. Set
    ///         once after Offers deploys — see Deploy.s.sol. Until set,
    ///         Offers literally cannot function (every makeOffer/
    ///         acceptOffer call would revert with NotOffersContract).
    address public offersContract;

    event OffersContractUpdated(address indexed offersContract);

    modifier onlyOffersContract() {
        if (msg.sender != offersContract) revert NotOffersContract();
        _;
    }

    modifier dailyActionLimit() {
        _consumeDailyAction(msg.sender);
        _;
    }

    function _consumeDailyAction(address agent) internal {
        uint256 currentWindow = block.timestamp / 1 days;
        if (dailyActionWindowIndex[agent] != currentWindow) {
            dailyActionWindowIndex[agent] = currentWindow;
            dailyActionCount[agent] = 0;
        }
        if (dailyActionCount[agent] >= MAX_DAILY_ACTIONS) revert DailyActionLimitReached();
        dailyActionCount[agent] += 1;
    }

    /// @notice Called by the Offers contract ONLY, to consume one action
    ///         from `agent`'s shared daily budget when they make or
    ///         accept an offer. Reverts with DailyActionLimitReached the
    ///         same way list()/buy() would if the agent's already at cap
    ///         today — from Offers.sol's caller's perspective, this
    ///         reverts exactly like hitting the limit inside Offers
    ///         itself would, just implemented via a cross-contract call
    ///         so the counter is genuinely shared, not duplicated.
    function consumeDailyAction(address agent) external onlyOffersContract whenNotPaused {
        _consumeDailyAction(agent);
    }

    function setOffersContract(address _offersContract) external onlyOwner {
        offersContract = _offersContract;
        emit OffersContractUpdated(_offersContract);
    }

    modifier onlyAgent() {
        if (!agentRegistry.isAgentWallet(msg.sender)) revert NotAgent();
        _;
    }

    constructor(address initialOwner, address usdcAddress, address _feeRecipient, address _agentRegistry, address _agentNFT)
        Ownable(initialOwner)
    {
        usdc = IERC20(usdcAddress);
        feeRecipient = _feeRecipient;
        agentRegistry = AgentRegistry(_agentRegistry);
        agentNFT = IERC721(_agentNFT);
    }

    /// @notice List an AgentNFT token for sale at a fixed USDC price.
    ///         Transfers the NFT into this contract's custody until sold
    ///         or cancelled. Reverts with NotAgent if msg.sender isn't a
    ///         registered agent wallet, MintNotEnded if the token's
    ///         collection is still in its active mint phase — see
    ///         AgentNFT.isCollectionMintEnded() — or DailyActionLimitReached
    ///         if you've already hit MAX_DAILY_ACTIONS combined list()+buy()
    ///         calls today.
    function list(uint256 tokenId, uint256 price) external onlyAgent dailyActionLimit nonReentrant whenNotPaused returns (uint256 listingId) {
        if (price == 0) revert PriceZero();
        if (block.timestamp < lastListAt[msg.sender] + MIN_LIST_INTERVAL) revert ListTooSoon();

        uint256 collectionId = IAgentNFTListingTracker(address(agentNFT)).tokenCollectionId(tokenId);
        if (!IAgentNFTListingTracker(address(agentNFT)).isCollectionMintEnded(collectionId)) revert MintNotEnded();

        lastListAt[msg.sender] = block.timestamp;

        agentNFT.transferFrom(msg.sender, address(this), tokenId);

        listingId = nextListingId++;
        listings[listingId] = Listing({seller: msg.sender, tokenId: tokenId, price: price, active: true});

        IAgentNFTListingTracker(address(agentNFT)).setActiveListing(tokenId, listingId);

        emit Listed(listingId, msg.sender, tokenId, price);
    }

    /// @notice Buy a listed NFT. Buyer must have approved this contract to
    ///         spend `price` USDC beforehand (standard ERC-20 approve flow —
    ///         separate from any x402 payment, since x402 covers the API
    ///         call that *triggers* this, not the on-chain settlement itself).
    ///         Reverts with NotAgent if msg.sender isn't a registered agent
    ///         wallet, or DailyActionLimitReached if you've already hit
    ///         MAX_DAILY_ACTIONS combined list()+buy() calls today.
    function buy(uint256 listingId) external onlyAgent dailyActionLimit nonReentrant whenNotPaused {
        Listing storage listing = listings[listingId];
        if (!listing.active) revert NotActive();
        listing.active = false;

        uint256 price = listing.price;
        uint256 royaltyAmount;
        address royaltyReceiver;

        if (IERC721(address(agentNFT)).supportsInterface(type(IERC2981).interfaceId)) {
            (royaltyReceiver, royaltyAmount) = IERC2981(address(agentNFT)).royaltyInfo(listing.tokenId, price);
        }

        uint256 fee = (price * feeBps) / 10_000;
        uint256 sellerProceeds = price - fee - royaltyAmount;

        usdc.transferFrom(msg.sender, listing.seller, sellerProceeds);
        if (royaltyAmount > 0) usdc.transferFrom(msg.sender, royaltyReceiver, royaltyAmount);
        if (fee > 0) usdc.transferFrom(msg.sender, feeRecipient, fee);

        agentNFT.transferFrom(address(this), msg.sender, listing.tokenId);
        IAgentNFTListingTracker(address(agentNFT)).setActiveListing(listing.tokenId, 0);

        emit Sold(listingId, msg.sender, price);
    }

    /// @notice Cancel a listing and return the NFT to the seller.
    /// @dev Deliberately NOT onlyAgent-gated. If an agent is later
    ///      deregistered (AgentRegistry.deregisterAgent), they must still
    ///      be able to reclaim their own already-listed NFT — the
    ///      `listing.seller != msg.sender` check already ensures only the
    ///      original (necessarily-agent-at-list-time) lister can cancel,
    ///      so re-checking agent status here would only ever hurt a
    ///      legitimate seller, never stop an attacker.
    function cancelListing(uint256 listingId) external nonReentrant {
        Listing storage listing = listings[listingId];
        if (!listing.active) revert NotActive();
        if (listing.seller != msg.sender) revert NotSeller();

        listing.active = false;
        agentNFT.transferFrom(address(this), msg.sender, listing.tokenId);
        IAgentNFTListingTracker(address(agentNFT)).setActiveListing(listing.tokenId, 0);

        emit Cancelled(listingId);
    }

    function setFee(uint96 _feeBps, address _feeRecipient) external onlyOwner {
        // MAX_FEE_BPS caps at 20% — well above any reasonable marketplace
        // fee, but critically LOW ENOUGH that combined with AgentNFT's
        // MAX_ROYALTY_BPS (10%), fee+royalty can never reach 100% of
        // price. Without this, an owner could set feeBps high enough that
        // `price - fee - royaltyAmount` underflows and reverts on EVERY
        // future sale, in both Marketplace.buy() AND Offers.acceptOffer()
        // (both share this exact math) — not an external-attacker vector
        // since only the owner can call this, but a real self-inflicted
        // foot-gun found and closed during review, not present originally.
        if (_feeBps > MAX_FEE_BPS) revert FeeTooHigh();
        feeBps = _feeBps;
        feeRecipient = _feeRecipient;
        emit FeeUpdated(_feeBps, _feeRecipient);
    }

    /// @notice Emergency circuit breaker — halts list()/buy()/
    ///         consumeDailyAction() (the latter meaning a paused
    ///         Marketplace also halts Offers.makeOffer()/acceptOffer(),
    ///         since both route through this shared counter — an extra
    ///         safety net even if you forget to separately pause Offers).
    ///         Deliberately does NOT pause cancelListing() — an agent
    ///         should always be able to reclaim their own NFT during an
    ///         emergency, same "never trap legitimate exits" reasoning
    ///         used throughout this codebase for cooldowns and gating.
    function pause() external onlyOwner {
        _pause();
    }

    function unpause() external onlyOwner {
        _unpause();
    }

    /// @notice Emergency withdrawal for USDC or NFTs stuck in this
    ///         contract due to a bug that normal withdrawal paths (buy/
    ///         cancelListing) can't reach — e.g. a token escrowed under a
    ///         listing whose accounting became inconsistent. Owner-only,
    ///         and deliberately unrestricted in WHAT it can move — a
    ///         genuine emergency valve, not a normal-operation function.
    ///         This is real centralization risk: the owner can move any
    ///         escrowed asset at any time. Documented plainly rather than
    ///         hidden — know this before trusting funds to this contract.
    function emergencyWithdrawUsdc(address to, uint256 amount) external onlyOwner {
        usdc.transfer(to, amount);
        emit EmergencyWithdrawal(address(usdc), to, amount);
    }

    function emergencyWithdrawNft(uint256 tokenId, address to) external onlyOwner {
        agentNFT.transferFrom(address(this), to, tokenId);
        emit EmergencyWithdrawal(address(agentNFT), to, tokenId);
    }
}
