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

interface IAgentNFTListingTracker {
    function setActiveListing(uint256 tokenId, uint256 listingId) external;
    function tokenCollectionId(uint256 tokenId) external view returns (uint256);
    function isCollectionMintEnded(uint256 collectionId) external view returns (bool);
}

/// @title Marketplace
/// @notice Fixed-price listing/buying escrow for the AgentNFT collection, in USDC.
contract Marketplace is ReentrancyGuard, Ownable, Pausable {
    using SafeERC20 for IERC20;

    struct Listing {
        address seller;
        bool active;
        uint256 tokenId;
        uint256 price;
    }

    IERC20 public immutable usdc;
    AgentRegistry public immutable agentRegistry;
    IERC721 public immutable agentNFT;
    uint256 public nextListingId = 1;
    mapping(uint256 => Listing) public listings;

    uint96 public constant MAX_FEE_BPS = 2000;
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
    /// @notice Thrown when a critical address parameter is the zero
    ///         address — found by an automated static analysis pass
    ///         (Slither). Without this, an accidental feeRecipient of
    ///         address(0) would permanently burn every future platform
    ///         fee, unrecoverably.
    error ZeroAddress();

    uint256 public constant MIN_LIST_INTERVAL = 10 seconds;
    mapping(address => uint256) public lastListAt;

    uint256 public constant MAX_DAILY_ACTIONS = 10;
    mapping(address => uint256) public dailyActionCount;
    mapping(address => uint256) public dailyActionWindowIndex;

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

    function consumeDailyAction(address agent) external onlyOffersContract whenNotPaused {
        _consumeDailyAction(agent);
    }

    function setOffersContract(address _offersContract) external onlyOwner {
        if (_offersContract == address(0)) revert ZeroAddress();
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
        if (_feeRecipient == address(0)) revert ZeroAddress();
        usdc = IERC20(usdcAddress);
        feeRecipient = _feeRecipient;
        agentRegistry = AgentRegistry(_agentRegistry);
        agentNFT = IERC721(_agentNFT);
    }

    function list(uint256 tokenId, uint256 price) external onlyAgent dailyActionLimit nonReentrant whenNotPaused returns (uint256 listingId) {
        if (price == 0) revert PriceZero();
        if (block.timestamp < lastListAt[msg.sender] + MIN_LIST_INTERVAL) revert ListTooSoon();

        uint256 collectionId = IAgentNFTListingTracker(address(agentNFT)).tokenCollectionId(tokenId);
        if (!IAgentNFTListingTracker(address(agentNFT)).isCollectionMintEnded(collectionId)) revert MintNotEnded();

        lastListAt[msg.sender] = block.timestamp;

        agentNFT.transferFrom(msg.sender, address(this), tokenId);

        listingId = nextListingId++;
        listings[listingId] = Listing({ seller: msg.sender, active: true, tokenId: tokenId, price: price });

        IAgentNFTListingTracker(address(agentNFT)).setActiveListing(tokenId, listingId);

        emit Listed(listingId, msg.sender, tokenId, price);
    }

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

        usdc.safeTransferFrom(msg.sender, listing.seller, sellerProceeds);
        if (royaltyAmount > 0) usdc.safeTransferFrom(msg.sender, royaltyReceiver, royaltyAmount);
        if (fee > 0) usdc.safeTransferFrom(msg.sender, feeRecipient, fee);

        agentNFT.transferFrom(address(this), msg.sender, listing.tokenId);
        IAgentNFTListingTracker(address(agentNFT)).setActiveListing(listing.tokenId, 0);

        emit Sold(listingId, msg.sender, price);
    }

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
        if (_feeBps > MAX_FEE_BPS) revert FeeTooHigh();
        if (_feeRecipient == address(0)) revert ZeroAddress();
        feeBps = _feeBps;
        feeRecipient = _feeRecipient;
        emit FeeUpdated(_feeBps, _feeRecipient);
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

    function emergencyWithdrawNft(uint256 tokenId, address to) external onlyOwner {
        agentNFT.transferFrom(address(this), to, tokenId);
        emit EmergencyWithdrawal(address(agentNFT), to, tokenId);
    }
}