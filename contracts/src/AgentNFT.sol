// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {ERC721} from "@openzeppelin/contracts/token/ERC721/ERC721.sol";
import {ERC721URIStorage} from "@openzeppelin/contracts/token/ERC721/extensions/ERC721URIStorage.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {ERC2981} from "@openzeppelin/contracts/token/common/ERC2981.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {AgentRegistry} from "./AgentRegistry.sol";

interface IMarketplaceFeeInfo {
    function feeBps() external view returns (uint96);
    function feeRecipient() external view returns (address);
}

/// @title AgentNFT
/// @notice ERC-721 collection for NFTs minted by AI agents.
contract AgentNFT is ERC721URIStorage, ERC2981, Ownable, ReentrancyGuard {
    using SafeERC20 for IERC20;

    uint256 private _nextTokenId;
    uint256 private _nextCollectionId = 1;

    AgentRegistry public immutable agentRegistry;
    IERC20 public immutable usdc;

    struct Collection {
        address creator;
        bool mintEndedManually;
        string creatorAgentId;
        uint256 maxSupply;
        uint256 mintedCount;
        uint256 mintPriceUsdc;
    }

    uint256 public constant MAX_COLLECTION_SUPPLY = 10_000;
    uint256 public constant MAX_SANE_MINT_PRICE = 1_000_000 * 1e6;

    mapping(uint256 => Collection) public collections;
    mapping(uint256 => uint256) public tokenCollectionId;
    mapping(uint256 => string) public creatorAgentId;
    mapping(uint256 => uint256) public activeListingId;

    address public marketplace;

    event CollectionCreated(uint256 indexed collectionId, address indexed creator, string creatorAgentId, uint256 maxSupply);
    event MintEnded(uint256 indexed collectionId);
    event Minted(uint256 indexed tokenId, uint256 indexed collectionId, address indexed to, string agentId, string tokenURI);
    event MarketplaceUpdated(address indexed marketplace);
    event MintPriceUpdated(uint256 indexed collectionId, uint256 priceUsdc);

    error NotMarketplace();
    error NotAgent();
    error RoyaltyTooHigh();
    error InvalidRoyalty();
    error MintTooSoon();
    error CollectionDoesNotExist();
    error CollectionSupplyZero();
    error CollectionSupplyTooHigh();
    error CollectionWeeklyLimitReached();
    error NotCollectionCreator();
    error CannotMintOwnCollection();
    error CollectionSoldOut();
    error MintAlreadyEnded();
    error MintPriceTooHigh();
    error PriceExceedsMax();
    /// @notice Thrown when a critical address parameter is the zero
    ///         address — found by an automated static analysis pass
    ///         (Slither). Without this, accidentally setting marketplace
    ///         to address(0) would silently disable every function
    ///         gated by onlyMarketplace, with no error to catch the
    ///         mistake at the time it happens.
    error ZeroAddress();

    uint96 public constant MAX_ROYALTY_BPS = 1000;
    uint256 public constant MIN_MINT_INTERVAL = 10 seconds;
    mapping(address => uint256) public lastMintAt;

    uint256 public constant MAX_COLLECTIONS_PER_WEEK = 2;
    mapping(address => uint256) public weeklyCollectionCount;
    mapping(address => uint256) public weeklyCollectionWindowIndex;

    modifier onlyMarketplace() {
        if (msg.sender != marketplace) revert NotMarketplace();
        _;
    }

    modifier onlyAgent() {
        if (!agentRegistry.isAgentWallet(msg.sender)) revert NotAgent();
        _;
    }

    constructor(address initialOwner, address _agentRegistry, address usdcAddress)
        ERC721("Agent NFT", "AGENTNFT")
        Ownable(initialOwner)
    {
        agentRegistry = AgentRegistry(_agentRegistry);
        usdc = IERC20(usdcAddress);
    }

    function setMarketplace(address _marketplace) external onlyOwner {
        if (_marketplace == address(0)) revert ZeroAddress();
        marketplace = _marketplace;
        emit MarketplaceUpdated(_marketplace);
    }

    function createCollection(uint256 maxSupply) external onlyAgent returns (uint256 collectionId) {
        if (maxSupply == 0) revert CollectionSupplyZero();
        if (maxSupply > MAX_COLLECTION_SUPPLY) revert CollectionSupplyTooHigh();

        uint256 currentWindow = block.timestamp / 7 days;
        if (weeklyCollectionWindowIndex[msg.sender] != currentWindow) {
            weeklyCollectionWindowIndex[msg.sender] = currentWindow;
            weeklyCollectionCount[msg.sender] = 0;
        }
        if (weeklyCollectionCount[msg.sender] >= MAX_COLLECTIONS_PER_WEEK) revert CollectionWeeklyLimitReached();
        weeklyCollectionCount[msg.sender] += 1;

        collectionId = _nextCollectionId++;
        string memory agentId = agentRegistry.agentIdOf(msg.sender);
        collections[collectionId] = Collection({
            creator: msg.sender,
            mintEndedManually: false,
            creatorAgentId: agentId,
            maxSupply: maxSupply,
            mintedCount: 0,
            mintPriceUsdc: 0
        });

        emit CollectionCreated(collectionId, msg.sender, agentId, maxSupply);
    }

    function setMintPrice(uint256 collectionId, uint256 priceUsdc) external {
        Collection storage collection = collections[collectionId];
        if (collection.creator == address(0)) revert CollectionDoesNotExist();
        if (collection.creator != msg.sender) revert NotCollectionCreator();
        if (priceUsdc > MAX_SANE_MINT_PRICE) revert MintPriceTooHigh();

        collection.mintPriceUsdc = priceUsdc;
        emit MintPriceUpdated(collectionId, priceUsdc);
    }

    function endMint(uint256 collectionId) external {
        Collection storage collection = collections[collectionId];
        if (collection.creator == address(0)) revert CollectionDoesNotExist();
        if (collection.creator != msg.sender) revert NotCollectionCreator();
        if (isCollectionMintEnded(collectionId)) revert MintAlreadyEnded();

        collection.mintEndedManually = true;
        emit MintEnded(collectionId);
    }

    function mint(uint256 collectionId, string calldata uri, address royaltyReceiver, uint96 royaltyBps, uint256 maxPriceUsdc)
        external
        onlyAgent
        nonReentrant
        returns (uint256 tokenId)
    {
        Collection storage collection = collections[collectionId];
        if (collection.creator == address(0)) revert CollectionDoesNotExist();
        if (collection.creator == msg.sender) revert CannotMintOwnCollection();
        if (collection.mintedCount >= collection.maxSupply) revert CollectionSoldOut();
        if (collection.mintEndedManually) revert MintAlreadyEnded();
        if (royaltyBps > MAX_ROYALTY_BPS) revert RoyaltyTooHigh();
        if (royaltyBps > 0 && royaltyReceiver == address(0)) revert InvalidRoyalty();
        if (block.timestamp < lastMintAt[msg.sender] + MIN_MINT_INTERVAL) revert MintTooSoon();
        lastMintAt[msg.sender] = block.timestamp;

        uint256 price = collection.mintPriceUsdc;
        if (price > maxPriceUsdc) revert PriceExceedsMax();

        if (price > 0) {
            uint96 platformFeeBps = 0;
            address platformFeeRecipient = address(0);
            if (marketplace != address(0)) {
                platformFeeBps = IMarketplaceFeeInfo(marketplace).feeBps();
                platformFeeRecipient = IMarketplaceFeeInfo(marketplace).feeRecipient();
            }
            uint256 platformFee = (price * platformFeeBps) / 10_000;
            uint256 curatorProceeds = price - platformFee;

            usdc.safeTransferFrom(msg.sender, collection.creator, curatorProceeds);
            if (platformFee > 0) usdc.safeTransferFrom(msg.sender, platformFeeRecipient, platformFee);
        }

        collection.mintedCount += 1;

        tokenId = ++_nextTokenId;
        _safeMint(msg.sender, tokenId);
        _setTokenURI(tokenId, uri);
        tokenCollectionId[tokenId] = collectionId;

        string memory agentId = agentRegistry.agentIdOf(msg.sender);
        creatorAgentId[tokenId] = agentId;

        if (royaltyReceiver != address(0) && royaltyBps > 0) {
            _setTokenRoyalty(tokenId, royaltyReceiver, royaltyBps);
        }
        emit Minted(tokenId, collectionId, msg.sender, agentId, uri);
    }

    function isCollectionMintEnded(uint256 collectionId) public view returns (bool) {
        Collection storage collection = collections[collectionId];
        return collection.mintEndedManually || collection.mintedCount >= collection.maxSupply;
    }

    function setActiveListing(uint256 tokenId, uint256 listingId) external onlyMarketplace {
        activeListingId[tokenId] = listingId;
    }

    function supportsInterface(bytes4 interfaceId) public view override(ERC721URIStorage, ERC2981) returns (bool) {
        return super.supportsInterface(interfaceId);
    }
}