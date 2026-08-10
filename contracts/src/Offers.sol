// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IERC721} from "@openzeppelin/contracts/token/ERC721/IERC721.sol";
import {IERC2981} from "@openzeppelin/contracts/interfaces/IERC2981.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {Pausable} from "@openzeppelin/contracts/utils/Pausable.sol";
import {AgentRegistry} from "./AgentRegistry.sol";

interface IAgentNFTOffers {
    function tokenCollectionId(uint256 tokenId) external view returns (uint256);
    function isCollectionMintEnded(uint256 collectionId) external view returns (bool);
}

interface IMarketplaceShared {
    function feeBps() external view returns (uint96);
    function feeRecipient() external view returns (address);
    function consumeDailyAction(address agent) external;
}

/// @title Offers
/// @notice Token-specific offers on AgentNFT tokens, escrowed in USDC at creation time.
contract Offers is ReentrancyGuard, Ownable, Pausable {
    using SafeERC20 for IERC20;

    struct Offer {
        address offerer;
        bool active;
        uint256 tokenId;
        uint256 amount;
        uint256 expiresAt;
    }

    IERC20 public immutable usdc;
    AgentRegistry public immutable agentRegistry;
    IERC721 public immutable agentNFT;
    address public immutable marketplace;

    uint256 public nextOfferId = 1;
    mapping(uint256 => Offer) public offers;

    uint256 public constant MAX_OFFER_DURATION = 30 days;

    event OfferMade(uint256 indexed offerId, address indexed offerer, uint256 indexed tokenId, uint256 amount, uint256 expiresAt);
    event OfferCancelled(uint256 indexed offerId);
    event OfferAccepted(uint256 indexed offerId, address indexed accepter, uint256 amount);
    event EmergencyWithdrawal(address indexed asset, address indexed to, uint256 amount);

    error NotAgent();
    error AmountZero();
    error DurationTooLong();
    error NotOfferer();
    error NotTokenOwner();
    error OfferExpired();
    error OfferNotActive();
    error MintNotEnded();
    /// @notice Thrown when a critical address parameter is the zero
    ///         address — found by an automated static analysis pass
    ///         (Slither).
    error ZeroAddress();

    modifier onlyAgent() {
        if (!agentRegistry.isAgentWallet(msg.sender)) revert NotAgent();
        _;
    }

    constructor(address initialOwner, address usdcAddress, address _agentRegistry, address _agentNFT, address _marketplace)
        Ownable(initialOwner)
    {
        if (_marketplace == address(0)) revert ZeroAddress();
        usdc = IERC20(usdcAddress);
        agentRegistry = AgentRegistry(_agentRegistry);
        agentNFT = IERC721(_agentNFT);
        marketplace = _marketplace;
    }

    function makeOffer(uint256 tokenId, uint256 amount, uint256 duration)
        external
        onlyAgent
        whenNotPaused
        nonReentrant
        returns (uint256 offerId)
    {
        if (amount == 0) revert AmountZero();
        if (duration > MAX_OFFER_DURATION) revert DurationTooLong();

        IMarketplaceShared(marketplace).consumeDailyAction(msg.sender);

        usdc.safeTransferFrom(msg.sender, address(this), amount);

        offerId = nextOfferId++;
        uint256 expiresAt = block.timestamp + duration;
        offers[offerId] = Offer({ offerer: msg.sender, active: true, tokenId: tokenId, amount: amount, expiresAt: expiresAt });

        emit OfferMade(offerId, msg.sender, tokenId, amount, expiresAt);
    }

    function cancelOffer(uint256 offerId) external nonReentrant {
        Offer storage offer = offers[offerId];
        if (!offer.active) revert OfferNotActive();
        if (offer.offerer != msg.sender) revert NotOfferer();

        offer.active = false;
        usdc.safeTransfer(msg.sender, offer.amount);

        emit OfferCancelled(offerId);
    }

    function acceptOffer(uint256 offerId) external onlyAgent whenNotPaused nonReentrant {
        Offer storage offer = offers[offerId];
        if (!offer.active) revert OfferNotActive();
        if (block.timestamp > offer.expiresAt) revert OfferExpired();
        if (agentNFT.ownerOf(offer.tokenId) != msg.sender) revert NotTokenOwner();

        uint256 collectionId = IAgentNFTOffers(address(agentNFT)).tokenCollectionId(offer.tokenId);
        if (!IAgentNFTOffers(address(agentNFT)).isCollectionMintEnded(collectionId)) revert MintNotEnded();

        IMarketplaceShared(marketplace).consumeDailyAction(msg.sender);

        offer.active = false;
        uint256 amount = offer.amount;

        uint256 royaltyAmount;
        address royaltyReceiver;
        if (IERC721(address(agentNFT)).supportsInterface(type(IERC2981).interfaceId)) {
            (royaltyReceiver, royaltyAmount) = IERC2981(address(agentNFT)).royaltyInfo(offer.tokenId, amount);
        }

        uint96 feeBps = IMarketplaceShared(marketplace).feeBps();
        address feeRecipient = IMarketplaceShared(marketplace).feeRecipient();
        uint256 fee = (amount * feeBps) / 10_000;
        uint256 sellerProceeds = amount - fee - royaltyAmount;

        address seller = msg.sender;
        agentNFT.transferFrom(seller, offer.offerer, offer.tokenId);

        usdc.safeTransfer(seller, sellerProceeds);
        if (royaltyAmount > 0) usdc.safeTransfer(royaltyReceiver, royaltyAmount);
        if (fee > 0) usdc.safeTransfer(feeRecipient, fee);

        emit OfferAccepted(offerId, offer.offerer, amount);
    }

    function pause() external onlyOwner {
        _pause();
    }

    function unpause() external onlyOwner {
        _unpause();
    }

    function emergencyWithdrawUsdc(address to, uint256 amount) external onlyOwner {
        usdc.safeTransfer(to, amount);
        emit EmergencyWithdrawal(address(usdc), to, amount);
    }
}