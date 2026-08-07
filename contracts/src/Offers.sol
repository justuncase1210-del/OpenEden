// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IERC721} from "@openzeppelin/contracts/token/ERC721/IERC721.sol";
import {IERC2981} from "@openzeppelin/contracts/interfaces/IERC2981.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {Pausable} from "@openzeppelin/contracts/utils/Pausable.sol";
import {AgentRegistry} from "./AgentRegistry.sol";

/// @notice Minimal interface for the AgentNFT reads Offers needs.
interface IAgentNFTMintStatus {
    function tokenCollectionId(uint256 tokenId) external view returns (uint256);
    function isCollectionMintEnded(uint256 collectionId) external view returns (bool);
}

/// @notice Minimal interface for the Marketplace calls Offers needs — the
///         shared daily action cap, plus the shared fee schedule (one
///         fee/royalty policy across both contracts, not duplicated).
interface IMarketplaceShared {
    function consumeDailyAction(address agent) external;
    function feeBps() external view returns (uint96);
    function feeRecipient() external view returns (address);
}

/// @title Offers
/// @notice Token-SPECIFIC offers (bids) on AgentNFT tokens — "I'll pay $X
///         for token #42," whether or not it's currently listed on
///         Marketplace. A separate contract from Marketplace, sharing its
///         daily action cap via a permissioned cross-contract call (see
///         Marketplace.consumeDailyAction) rather than a duplicated one.
/// @dev COLLECTION-WIDE OFFERS ("I'll pay $X for any token in this
///      collection") ARE DELIBERATELY OUT OF SCOPE HERE. That's a
///      genuinely different feature — partial-fill semantics, which
///      specific token satisfies the offer, whether one offer can be
///      accepted by multiple different owners — scoped out as an
///      explicit v2, not an oversight.
/// @dev ESCROW MODEL: USDC is pulled into this contract's custody the
///      moment an offer is made (`makeOffer`'s transferFrom), NOT at
///      accept time. Chosen deliberately over a pull-at-accept model
///      after discussing the tradeoff — this is the real-marketplace-
///      standard choice (OpenSea/Blur both escrow), guaranteeing a
///      displayed "offer" is genuinely fundable, at the cost of the
///      offerer's capital efficiency while an offer is pending.
/// @dev AGENT-ONLY, same hard enforcement as everywhere else in this
///      system — `makeOffer`/`acceptOffer` check AgentRegistry directly.
///      `cancelOffer` is deliberately NOT gated, same "always allow exit"
///      reasoning as Marketplace.cancelListing.
/// @dev APPROVAL REQUIREMENT, easy to miss: `acceptOffer` transfers the
///      NFT via transferFrom, called BY this contract on the current
///      owner's behalf — the owner MUST approve this contract for the
///      token first (agentNFT.approve(address(offers), tokenId) or
///      setApprovalForAll), exactly like sellers must approve Marketplace
///      before list(). Not documented anywhere until this review pass —
///      a real integration trap otherwise, since accepting an offer
///      doesn't feel like it should need the SAME approval flow as
///      listing, but it does.
contract Offers is ReentrancyGuard, Ownable, Pausable {
    struct Offer {
        address offerer;
        uint256 tokenId;
        uint256 amount; // USDC base units (6 decimals), held in escrow here
        uint256 expiresAt;
        bool active;
    }

    IERC20 public immutable usdc;
    AgentRegistry public immutable agentRegistry;
    IERC721 public immutable agentNFT;
    IMarketplaceShared public immutable marketplace;

    uint256 public nextOfferId = 1;
    mapping(uint256 => Offer) public offers;

    /// @notice Max how far in the future an offer's expiry can be set —
    ///         same "cap everything that could otherwise grow unbounded"
    ///         instinct as AgentNFT's royalty/supply caps.
    uint256 public constant MAX_OFFER_DURATION = 30 days;

    event OfferMade(uint256 indexed offerId, address indexed offerer, uint256 indexed tokenId, uint256 amount, uint256 expiresAt);
    event OfferCancelled(uint256 indexed offerId);
    event EmergencyWithdrawal(address indexed to, uint256 amount);
    event OfferAccepted(uint256 indexed offerId, address indexed accepter, uint256 amount);

    error NotAgent();
    error OfferDoesNotExist();
    error OfferNotActive();
    error OfferExpired();
    error DurationTooLong();
    error AmountZero();
    error NotOfferer();
    error NotTokenOwner();
    error MintNotEnded();

    modifier onlyAgent() {
        if (!agentRegistry.isAgentWallet(msg.sender)) revert NotAgent();
        _;
    }

    constructor(address initialOwner, address usdcAddress, address _agentRegistry, address _agentNFT, address _marketplace)
        Ownable(initialOwner)
    {
        usdc = IERC20(usdcAddress);
        agentRegistry = AgentRegistry(_agentRegistry);
        agentNFT = IERC721(_agentNFT);
        marketplace = IMarketplaceShared(_marketplace);
    }

    /// @notice Emergency circuit breaker for makeOffer/acceptOffer.
    ///         Deliberately does NOT pause cancelOffer() — an offerer
    ///         should always be able to reclaim their escrowed USDC
    ///         during an emergency, same "never trap legitimate exits"
    ///         reasoning used throughout this codebase.
    function pause() external onlyOwner {
        _pause();
    }

    function unpause() external onlyOwner {
        _unpause();
    }

    /// @notice Emergency withdrawal for USDC stuck in this contract due
    ///         to a bug normal paths (acceptOffer/cancelOffer) can't
    ///         reach. Owner-only. Real centralization risk — the owner
    ///         can move any escrowed offer amount at any time. Documented
    ///         plainly, not hidden.
    function emergencyWithdrawUsdc(address to, uint256 amount) external onlyOwner {
        usdc.transfer(to, amount);
        emit EmergencyWithdrawal(to, amount);
    }

    /// @notice Make an offer on tokenId, escrowing `amount` USDC
    ///         immediately (requires prior ERC-20 approval of this
    ///         contract for at least `amount`). Reverts with
    ///         DailyActionLimitReached via Marketplace's shared counter
    ///         if you've already hit MAX_DAILY_ACTIONS combined
    ///         list()/buy()/offer actions today.
    function makeOffer(uint256 tokenId, uint256 amount, uint256 durationSeconds)
        external
        onlyAgent
        nonReentrant
        whenNotPaused
        returns (uint256 offerId)
    {
        if (amount == 0) revert AmountZero();
        if (durationSeconds > MAX_OFFER_DURATION) revert DurationTooLong();

        marketplace.consumeDailyAction(msg.sender);

        usdc.transferFrom(msg.sender, address(this), amount);

        offerId = nextOfferId++;
        uint256 expiresAt = block.timestamp + durationSeconds;
        offers[offerId] = Offer({offerer: msg.sender, tokenId: tokenId, amount: amount, expiresAt: expiresAt, active: true});

        emit OfferMade(offerId, msg.sender, tokenId, amount, expiresAt);
    }

    /// @notice Cancel your own offer and reclaim the escrowed USDC.
    ///         Works even after expiry or deregistration — same "always
    ///         allow exit" reasoning as Marketplace.cancelListing. Does
    ///         NOT consume a daily action.
    function cancelOffer(uint256 offerId) external nonReentrant {
        Offer storage offer = offers[offerId];
        if (offer.offerer == address(0)) revert OfferDoesNotExist();
        if (!offer.active) revert OfferNotActive();
        if (offer.offerer != msg.sender) revert NotOfferer();

        offer.active = false;
        usdc.transfer(msg.sender, offer.amount);

        emit OfferCancelled(offerId);
    }

    /// @notice Accept an offer on a token you currently own. REQUIRES you
    ///         to have approved this contract for `offer.tokenId` first —
    ///         either agentNFT.approve(address(offersContract), tokenId)
    ///         or setApprovalForAll — same requirement as Marketplace.
    ///         list(), just easy to miss here since it's not the contract
    ///         you're directly calling to "list" something. Without it,
    ///         this reverts with a standard ERC-721 "caller is not owner
    ///         nor approved" error, not one of the custom errors below.
    ///         Splits the escrowed USDC using the SAME fee+royalty math as
    ///         Marketplace.buy(), reading feeBps/feeRecipient FROM
    ///         Marketplace directly rather than duplicating fee config.
    ///         Reverts with:
    ///         - OfferExpired if past its expiry
    ///         - NotTokenOwner if you don't currently own the token
    ///           (this is also what naturally invalidates a stale offer
    ///           after the token changed hands via a regular sale or a
    ///           different accepted offer — no explicit cleanup needed)
    ///         - MintNotEnded if the token's collection is still actively
    ///           minting — same gate as Marketplace.list(), but applied
    ///           here at ACCEPT time rather than offer-creation, so
    ///           agents can speculatively offer on tokens from
    ///           still-minting collections
    ///         - DailyActionLimitReached via the shared counter
    function acceptOffer(uint256 offerId) external onlyAgent nonReentrant whenNotPaused {
        Offer storage offer = offers[offerId];
        if (offer.offerer == address(0)) revert OfferDoesNotExist();
        if (!offer.active) revert OfferNotActive();
        if (block.timestamp > offer.expiresAt) revert OfferExpired();
        if (agentNFT.ownerOf(offer.tokenId) != msg.sender) revert NotTokenOwner();

        uint256 collectionId = IAgentNFTMintStatus(address(agentNFT)).tokenCollectionId(offer.tokenId);
        if (!IAgentNFTMintStatus(address(agentNFT)).isCollectionMintEnded(collectionId)) revert MintNotEnded();

        marketplace.consumeDailyAction(msg.sender);

        offer.active = false;

        uint256 amount = offer.amount;
        uint256 royaltyAmount;
        address royaltyReceiver;

        if (IERC721(address(agentNFT)).supportsInterface(type(IERC2981).interfaceId)) {
            (royaltyReceiver, royaltyAmount) = IERC2981(address(agentNFT)).royaltyInfo(offer.tokenId, amount);
        }

        uint96 feeBps = marketplace.feeBps();
        uint256 fee = (amount * feeBps) / 10_000;
        uint256 sellerProceeds = amount - fee - royaltyAmount;

        usdc.transfer(msg.sender, sellerProceeds); // accepter IS the seller here
        if (royaltyAmount > 0) usdc.transfer(royaltyReceiver, royaltyAmount);
        if (fee > 0) usdc.transfer(marketplace.feeRecipient(), fee);

        agentNFT.transferFrom(msg.sender, offer.offerer, offer.tokenId);

        emit OfferAccepted(offerId, msg.sender, amount);
    }
}
