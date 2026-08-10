// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {AgentNFT} from "../src/AgentNFT.sol";
import {AgentRegistry} from "../src/AgentRegistry.sol";
import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";

contract MockUSDC is ERC20 {
    constructor() ERC20("Mock USDC", "USDC") {}
    function decimals() public pure override returns (uint8) { return 6; }
    function mint(address to, uint256 amount) external { _mint(to, amount); }
}

contract AgentNFTTest is Test {
    AgentRegistry registry;
    AgentNFT nft;
    MockUSDC usdc;

    address deployer = address(0xA11CE);
    address curator = address(0xC0);
    address minter = address(0xB0B);
    address otherMinter = address(0xC0FFEE);
    address randomWallet = address(0xBAD);
    address feeRecipient = address(0xFEE);

    uint256 collectionId;
    uint256 constant NO_MAX = type(uint256).max;

    function setUp() public {
        vm.warp(100);

        vm.startPrank(deployer);
        registry = new AgentRegistry(deployer);
        usdc = new MockUSDC();
        nft = new AgentNFT(deployer, address(registry), address(usdc));
        registry.registerAgent(curator, "agent-curator");
        registry.registerAgent(minter, "agent-minter");
        registry.registerAgent(otherMinter, "agent-other-minter");
        vm.stopPrank();

        vm.prank(curator);
        collectionId = nft.createCollection(100);
    }

    function test_CreateCollectionSetsCreatorAndCap() public {
        (address creator, bool ended, string memory creatorAgentId, uint256 maxSupply, uint256 mintedCount, uint256 mintPrice) = nft.collections(collectionId);
        assertEq(creator, curator);
        assertEq(creatorAgentId, "agent-curator");
        assertEq(maxSupply, 100);
        assertEq(mintedCount, 0);
        assertFalse(ended);
        assertEq(mintPrice, 0);
    }

    function test_RevertWhen_NonAgentCreatesCollection() public {
        vm.prank(randomWallet);
        vm.expectRevert(AgentNFT.NotAgent.selector);
        nft.createCollection(100);
    }

    function test_RevertWhen_CollectionSupplyZero() public {
        vm.prank(minter);
        vm.expectRevert(AgentNFT.CollectionSupplyZero.selector);
        nft.createCollection(0);
    }

    function test_RevertWhen_CollectionSupplyExceedsMax() public {
        vm.prank(minter);
        vm.expectRevert(AgentNFT.CollectionSupplyTooHigh.selector);
        nft.createCollection(10_001);
    }

    function test_CollectionSupplyAtExactCapSucceeds() public {
        vm.prank(minter);
        uint256 id = nft.createCollection(10_000);
        (, , , uint256 maxSupply, , ) = nft.collections(id);
        assertEq(maxSupply, 10_000);
    }

    function test_CollectionCreationLimitsAndEvents() public {
        vm.prank(curator);
        vm.expectEmit(true, true, false, true);
        emit AgentNFT.CollectionCreated(2, curator, "agent-curator", 50);

        uint256 secondId = nft.createCollection(50);
        assertTrue(secondId != collectionId);

        vm.prank(curator);
        vm.expectRevert(AgentNFT.CollectionWeeklyLimitReached.selector);
        nft.createCollection(25);
    }

    function test_CollectionCreationResetsAfterWeekElapses() public {
        vm.prank(curator);
        nft.createCollection(50);

        vm.warp(block.timestamp + 7 days);

        vm.prank(curator);
        uint256 id = nft.createCollection(30);
        assertTrue(id != collectionId);
    }

    function test_OtherAgentCanMintIntoCollection() public {
        vm.prank(minter);
        uint256 tokenId = nft.mint(collectionId, "ipfs://example-uri", address(0), 0, NO_MAX);

        assertEq(nft.ownerOf(tokenId), minter);
        assertEq(nft.tokenURI(tokenId), "ipfs://example-uri");
        assertEq(nft.creatorAgentId(tokenId), "agent-minter");
        assertEq(nft.tokenCollectionId(tokenId), collectionId);

        (, , , , uint256 mintedCount, ) = nft.collections(collectionId);
        assertEq(mintedCount, 1);
    }

    function test_DifferentMintersCanBothMintIntoSameCollection() public {
        vm.prank(minter);
        uint256 tokenId1 = nft.mint(collectionId, "ipfs://first", address(0), 0, NO_MAX);

        vm.warp(block.timestamp + nft.MIN_MINT_INTERVAL());
        vm.prank(otherMinter);
        uint256 tokenId2 = nft.mint(collectionId, "ipfs://second", address(0), 0, NO_MAX);

        assertEq(nft.ownerOf(tokenId1), minter);
        assertEq(nft.ownerOf(tokenId2), otherMinter);
        assertEq(nft.creatorAgentId(tokenId1), "agent-minter");
        assertEq(nft.creatorAgentId(tokenId2), "agent-other-minter");

        (, , , , uint256 mintedCount, ) = nft.collections(collectionId);
        assertEq(mintedCount, 2);
    }

    function test_RevertWhen_CuratorMintsOwnCollection() public {
        vm.prank(curator);
        vm.expectRevert(AgentNFT.CannotMintOwnCollection.selector);
        nft.mint(collectionId, "ipfs://example-uri", address(0), 0, NO_MAX);
    }

    function test_RevertWhen_MintingIntoNonexistentCollection() public {
        vm.prank(minter);
        vm.expectRevert(AgentNFT.CollectionDoesNotExist.selector);
        nft.mint(9999, "ipfs://example-uri", address(0), 0, NO_MAX);
    }

    function test_RevertWhen_NonAgentMints() public {
        vm.prank(randomWallet);
        vm.expectRevert(AgentNFT.NotAgent.selector);
        nft.mint(collectionId, "ipfs://example-uri", address(0), 0, NO_MAX);
    }

    function test_RevertWhen_DeregisteredAgentMints() public {
        vm.prank(deployer);
        registry.deregisterAgent(minter);

        vm.prank(minter);
        vm.expectRevert(AgentNFT.NotAgent.selector);
        nft.mint(collectionId, "ipfs://example-uri", address(0), 0, NO_MAX);
    }

    function test_CollectionSellsOutAtMaxSupply() public {
        vm.prank(curator);
        uint256 smallCollection = nft.createCollection(1);

        vm.prank(minter);
        nft.mint(smallCollection, "ipfs://only-one", address(0), 0, NO_MAX);

        assertTrue(nft.isCollectionMintEnded(smallCollection));
    }

    function test_RevertWhen_MintingSoldOutCollection() public {
        vm.prank(curator);
        uint256 smallCollection = nft.createCollection(1);

        vm.prank(minter);
        nft.mint(smallCollection, "ipfs://only-one", address(0), 0, NO_MAX);

        vm.warp(block.timestamp + nft.MIN_MINT_INTERVAL());
        vm.prank(otherMinter);
        vm.expectRevert(AgentNFT.CollectionSoldOut.selector);
        nft.mint(smallCollection, "ipfs://second-attempt", address(0), 0, NO_MAX);
    }

    function test_EndMintByCuratorEndsPhaseEarly() public {
        assertFalse(nft.isCollectionMintEnded(collectionId));

        vm.prank(curator);
        nft.endMint(collectionId);

        assertTrue(nft.isCollectionMintEnded(collectionId));
    }

    function test_RevertWhen_NonCuratorEndsMint() public {
        vm.prank(minter);
        vm.expectRevert(AgentNFT.NotCollectionCreator.selector);
        nft.endMint(collectionId);
    }

    function test_RevertWhen_EndingAlreadyEndedMint() public {
        vm.prank(curator);
        nft.endMint(collectionId);

        vm.prank(curator);
        vm.expectRevert(AgentNFT.MintAlreadyEnded.selector);
        nft.endMint(collectionId);
    }

    function test_RevertWhen_MintingAfterCuratorEndsIt() public {
        vm.prank(curator);
        nft.endMint(collectionId);

        vm.prank(minter);
        vm.expectRevert(AgentNFT.MintAlreadyEnded.selector);
        nft.mint(collectionId, "ipfs://should-fail", address(0), 0, NO_MAX);
    }

    function test_RevertWhen_MintingTooSoon() public {
        vm.prank(minter);
        nft.mint(collectionId, "ipfs://first", address(0), 0, NO_MAX);

        vm.prank(minter);
        vm.expectRevert(AgentNFT.MintTooSoon.selector);
        nft.mint(collectionId, "ipfs://second", address(0), 0, NO_MAX);
    }

    function test_MintSucceedsAfterCooldownElapses() public {
        vm.prank(minter);
        nft.mint(collectionId, "ipfs://first", address(0), 0, NO_MAX);

        vm.warp(block.timestamp + nft.MIN_MINT_INTERVAL());

        vm.prank(minter);
        uint256 tokenId = nft.mint(collectionId, "ipfs://second", address(0), 0, NO_MAX);
        assertEq(nft.ownerOf(tokenId), minter);
    }

    function test_RoyaltyInfoReadsBack() public {
        vm.prank(minter);
        uint256 tokenId = nft.mint(collectionId, "ipfs://example-uri", minter, 500, NO_MAX);

        (address receiver, uint256 amount) = nft.royaltyInfo(tokenId, 1_000_000);
        assertEq(receiver, minter);
        assertEq(amount, 50_000);
    }

    function test_RevertWhen_RoyaltyExceedsCap() public {
        vm.prank(minter);
        vm.expectRevert(AgentNFT.RoyaltyTooHigh.selector);
        nft.mint(collectionId, "ipfs://example-uri", minter, 1001, NO_MAX);
    }

    function test_RoyaltyAtExactCapSucceeds() public {
        vm.prank(minter);
        uint256 tokenId = nft.mint(collectionId, "ipfs://example-uri", minter, 1000, NO_MAX);
        (, uint256 amount) = nft.royaltyInfo(tokenId, 1_000_000);
        assertEq(amount, 100_000);
    }

    function test_RevertWhen_RoyaltyReceiverIsZeroWithNonZeroBps() public {
        vm.prank(minter);
        vm.expectRevert(AgentNFT.InvalidRoyalty.selector);
        nft.mint(collectionId, "ipfs://example-uri", address(0), 500, NO_MAX);
    }

    function test_SetMintPriceByCurator() public {
        vm.prank(curator);
        nft.setMintPrice(collectionId, 5_000_000);

        (, , , , , uint256 mintPrice) = nft.collections(collectionId);
        assertEq(mintPrice, 5_000_000);
    }

    function test_RevertWhen_NonCuratorSetsMintPrice() public {
        vm.prank(minter);
        vm.expectRevert(AgentNFT.NotCollectionCreator.selector);
        nft.setMintPrice(collectionId, 5_000_000);
    }

    function test_RevertWhen_MintPriceExceedsSaneMax() public {
        uint256 tooHigh = nft.MAX_SANE_MINT_PRICE() + 1;
        vm.prank(curator);
        vm.expectRevert(AgentNFT.MintPriceTooHigh.selector);
        nft.setMintPrice(collectionId, tooHigh);
    }

    function test_MintStillFreeWithNoPriceSet() public {
        vm.prank(minter);
        uint256 tokenId = nft.mint(collectionId, "ipfs://free", address(0), 0, NO_MAX);
        assertEq(nft.ownerOf(tokenId), minter);
    }

    function test_MintPullsUsdcAndSplitsFeeWithCurator() public {
        vm.prank(curator);
        nft.setMintPrice(collectionId, 10_000_000);

        usdc.mint(minter, 10_000_000);
        vm.prank(minter);
        usdc.approve(address(nft), 10_000_000);

        uint256 curatorBalanceBefore = usdc.balanceOf(curator);

        vm.prank(minter);
        nft.mint(collectionId, "ipfs://priced", address(0), 0, 10_000_000);

        assertEq(usdc.balanceOf(curator), curatorBalanceBefore + 10_000_000);
        assertEq(usdc.balanceOf(minter), 0);
    }

    function test_RevertWhen_MintingPricedCollectionWithoutApproval() public {
        vm.prank(curator);
        nft.setMintPrice(collectionId, 10_000_000);

        usdc.mint(minter, 10_000_000);

        vm.prank(minter);
        vm.expectRevert();
        nft.mint(collectionId, "ipfs://should-fail", address(0), 0, 10_000_000);
    }

    /// @notice THE new test proving the front-running fix actually works:
    ///         curator raises the price AFTER the minter decided their
    ///         max, and the mint correctly reverts instead of silently
    ///         charging more than the minter agreed to.
    function test_RevertWhen_PriceExceedsMax() public {
        vm.prank(curator);
        nft.setMintPrice(collectionId, 10_000_000); // 10 USDC

        usdc.mint(minter, 10_000_000);
        vm.prank(minter);
        usdc.approve(address(nft), 10_000_000);

        // Minter only agrees to pay up to 5 USDC — but the real price is 10.
        vm.prank(minter);
        vm.expectRevert(AgentNFT.PriceExceedsMax.selector);
        nft.mint(collectionId, "ipfs://should-fail", address(0), 0, 5_000_000);

        // Confirm no USDC moved and no token was minted.
        assertEq(usdc.balanceOf(minter), 10_000_000);
        assertEq(usdc.balanceOf(curator), 0);
    }

    function testFuzz_RevertWhen_RoyaltyExceedsCap(uint96 royaltyBps) public {
        vm.assume(royaltyBps > nft.MAX_ROYALTY_BPS());
        vm.prank(minter);
        vm.expectRevert(AgentNFT.RoyaltyTooHigh.selector);
        nft.mint(collectionId, "ipfs://fuzz", minter, royaltyBps, NO_MAX);
    }

    function testFuzz_RoyaltyWithinCapIsAlwaysExactlyProportional(uint96 royaltyBps) public {
        royaltyBps = uint96(bound(royaltyBps, 1, nft.MAX_ROYALTY_BPS()));
        vm.prank(minter);
        uint256 tokenId = nft.mint(collectionId, "ipfs://fuzz", minter, royaltyBps, NO_MAX);
        (address receiver, uint256 amount) = nft.royaltyInfo(tokenId, 1_000_000);
        assertEq(receiver, minter);
        assertEq(amount, (uint256(royaltyBps) * 1_000_000) / 10_000);
    }
    function test_RevertWhen_SettingMarketplaceToZeroAddress() public {
        vm.prank(deployer);
        vm.expectRevert(AgentNFT.ZeroAddress.selector);
        nft.setMarketplace(address(0));
    }
}