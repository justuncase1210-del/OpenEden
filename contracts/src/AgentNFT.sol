// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {ERC721} from "@openzeppelin/contracts/token/ERC721/ERC721.sol";
import {ERC721URIStorage} from "@openzeppelin/contracts/token/ERC721/extensions/ERC721URIStorage.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {ERC2981} from "@openzeppelin/contracts/token/common/ERC2981.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {AgentRegistry} from "./AgentRegistry.sol";

/// @notice Minimal interface for reading Marketplace's fee config — kept
///         separate to avoid a circular import. mint() reads the SAME
///         feeBps/feeRecipient Marketplace already uses for trades,
///         rather than duplicating a second fee number that could drift
///         out of sync with it.
interface IMarketplaceFeeInfo {
    function feeBps() external view returns (uint96);
    function feeRecipient() external view returns (address);
}

/// @title AgentNFT
/// @notice ERC-721 collection for NFTs minted by AI agents. Each token
///         stores a metadata URI (JSON pinned to IPFS — see the backend's
///         /api/nfts/prepare-metadata) and an optional per-token creator
///         royalty via ERC-2981.
/// @dev One shared CONTRACT for the whole marketplace, but tokens are
///      grouped into agent-created COLLECTIONS within it (a `Collection`
///      struct, not a separate deployed contract per collection) —
///      similar to how OpenSea's shared storefront works, but with real
///      per-collection supply caps and mint phases rather than one flat
///      token pool.
///
/// @dev COLLECTIONS, SUPPLY CAPS, AND MINT PHASES: an agent calls
///      `createCollection(maxSupply)` to start one (maxSupply capped at
///      MAX_COLLECTION_SUPPLY = 10,000) — no limit on how many
///      collections one agent can create (beyond the anti-spam cooldown
///      between creations). A collection's creator is a CURATOR, not a
///      minter: they define the theme and supply cap but CANNOT mint
///      into their own collection — only OTHER registered agents can,
///      and each minter owns whatever they personally mint.
///
/// @dev MINT PRICING (NEW): a curator can optionally call
///      `setMintPrice(collectionId, priceUsdc)` any time after creating
///      a collection. Defaults to 0 (free — unchanged from before this
///      was added). If a price is set, `mint()` pulls that much USDC
///      from the MINTER (not the curator), splits it using Marketplace's
///      existing fee rate (2.5% by default) to the platform, the rest to
///      the curator. REQUIRES the minter to have called
///      `usdc.approve(address(agentNFT), price)` beforehand — same
///      approve-then-call pattern as Marketplace.buy(), easy to forget
///      if you're integrating without reading this comment.
///
/// @dev MINTING IS AGENT-SELF-SERVICE, NOT RELAYER-EXECUTED. Agents sign
///      their own mint transaction with their own wallet (and their own
///      Base Sepolia ETH for gas, plus USDC if the collection is priced).
///      The backend's role narrows to: pin metadata to IPFS and hand back
///      a tokenURI, nothing more.
contract AgentNFT is ERC721URIStorage, ERC2981, Ownable, ReentrancyGuard {
    uint256 private _nextTokenId;
    uint256 private _nextCollectionId = 1;

    AgentRegistry public immutable agentRegistry;
    IERC20 public immutable usdc;

    struct Collection {
        address creator;
        string creatorAgentId;
        uint256 maxSupply;
        uint256 mintedCount;
        bool mintEndedManually;
        uint256 mintPriceUsdc; // NEW — appended at the end, not inserted
                                // in the middle, to keep every EXISTING
                                // field's position unchanged in the
                                // auto-generated collections() getter.
                                // Still changes the tuple's total length
                                // though — any code destructuring it
                                // needs one more value added at the end.
    }

    uint256 public constant MAX_COLLECTION_SUPPLY = 10_000;

    /// @notice Sanity ceiling on mint price — NOT a meaningful business
    ///         limit, just a guard against a curator fat-fingering an
    ///         extra zero or two. $1,000,000 USDC (6 decimals).
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
            creatorAgentId: agentId,
            maxSupply: maxSupply,
            mintedCount: 0,
            mintEndedManually: false,
            mintPriceUsdc: 0 // free by default — unchanged behavior unless the curator opts in
        });

        emit CollectionCreated(collectionId, msg.sender, agentId, maxSupply);
    }

    /// @notice Set (or change) what OTHER agents must pay in USDC to mint
    ///         into your collection. 0 = free. Curator-only, callable at
    ///         any time — including mid-mint-phase, to adjust pricing.
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

    /// @notice Mint a new NFT into `collectionId`, to yourself. If the
    ///         collection has a mint price set, this pulls that much
    ///         USDC from YOU (the minter) — approve this contract for
    ///         that amount first, or this reverts on the transferFrom.
    ///         Split: Marketplace's current feeBps to the platform, the
    ///         rest to the collection's curator.
    function mint(uint256 collectionId, string calldata uri, address royaltyReceiver, uint96 royaltyBps)
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

        // Mint fee, if this collection has one — pulled BEFORE the NFT
        // is minted, so a failed payment never leaves a half-completed
        // mint. Reads Marketplace's live fee rate rather than a second,
        // separately-tracked number.
        uint256 price = collection.mintPriceUsdc;
        if (price > 0) {
            uint96 platformFeeBps = 0;
            address platformFeeRecipient = address(0);
            if (marketplace != address(0)) {
                platformFeeBps = IMarketplaceFeeInfo(marketplace).feeBps();
                platformFeeRecipient = IMarketplaceFeeInfo(marketplace).feeRecipient();
            }
            uint256 platformFee = (price * platformFeeBps) / 10_000;
            uint256 curatorProceeds = price - platformFee;

            usdc.transferFrom(msg.sender, collection.creator, curatorProceeds);
            if (platformFee > 0) usdc.transferFrom(msg.sender, platformFeeRecipient, platformFee);
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