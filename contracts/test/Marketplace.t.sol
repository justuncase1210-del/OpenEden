// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {AgentRegistry} from "../src/AgentRegistry.sol";
import {AgentNFT} from "../src/AgentNFT.sol";
import {Marketplace} from "../src/Marketplace.sol";
import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";

contract MockUSDC is ERC20 {
    constructor() ERC20("Mock USDC", "USDC") {}
    function decimals() public pure override returns (uint8) { return 6; }
    function mint(address to, uint256 amount) external { _mint(to, amount); }
}

contract MarketplaceTest is Test {
    AgentRegistry registry;
    AgentNFT nft;
    Marketplace marketplace;
    MockUSDC usdc;

    address deployer = address(0xA11CE);
    address feeRecipient = address(0xFEE);
    address curator = address(0xC0);
    address seller = address(0x5E11E7);
    address buyer = address(0xB0714);
    address randomWallet = address(0xBAD);

    uint256 constant PRICE = 10_000_000;
    uint256 constant NO_MAX = type(uint256).max;

    function setUp() public {
        vm.warp(100);
        vm.startPrank(deployer);
        registry = new AgentRegistry(deployer);
        usdc = new MockUSDC();
        nft = new AgentNFT(deployer, address(registry), address(usdc));
        marketplace = new Marketplace(deployer, address(usdc), feeRecipient, address(registry), address(nft));
        nft.setMarketplace(address(marketplace));

        registry.registerAgent(curator, "agent-curator");
        registry.registerAgent(seller, "agent-seller");
        registry.registerAgent(buyer, "agent-buyer");
        vm.stopPrank();

        vm.prank(curator);
        uint256 collectionId = nft.createCollection(10);

        vm.startPrank(seller);
        uint256 tokenId = nft.mint(collectionId, "ipfs://example", address(0), 0, NO_MAX);
        nft.approve(address(marketplace), tokenId);
        vm.stopPrank();

        vm.prank(curator);
        nft.endMint(collectionId);

        usdc.mint(buyer, PRICE);
        vm.prank(buyer);
        usdc.approve(address(marketplace), PRICE);
    }

    function _mintedTokenId() internal pure returns (uint256) {
        return 1;
    }

    function _prepareSecondListableToken() internal returns (uint256 tokenId) {
        vm.warp(block.timestamp + nft.MIN_MINT_INTERVAL());

        vm.prank(curator);
        uint256 collectionId = nft.createCollection(10);

        vm.startPrank(seller);
        tokenId = nft.mint(collectionId, "ipfs://second", address(0), 0, NO_MAX);
        nft.approve(address(marketplace), tokenId);
        vm.stopPrank();

        vm.prank(curator);
        nft.endMint(collectionId);
    }

    function test_ListTransfersNftToEscrowAndSetsActiveListing() public {
        uint256 tokenId = _mintedTokenId();
        vm.prank(seller);
        uint256 listingId = marketplace.list(tokenId, PRICE);

        assertEq(nft.ownerOf(tokenId), address(marketplace));
        assertEq(nft.activeListingId(tokenId), listingId);

        (address listedSeller, bool active, , uint256 price) = marketplace.listings(listingId);
        assertEq(listedSeller, seller);
        assertEq(price, PRICE);
        assertTrue(active);
    }

    function test_RevertWhen_NonAgentLists() public {
        uint256 tokenId = _mintedTokenId();
        vm.prank(randomWallet);
        vm.expectRevert(Marketplace.NotAgent.selector);
        marketplace.list(tokenId, PRICE);
    }

    function test_BuyTransfersNftAndSplitsPaymentCorrectly() public {
        uint256 tokenId = _mintedTokenId();
        vm.prank(seller);
        uint256 listingId = marketplace.list(tokenId, PRICE);

        vm.prank(buyer);
        marketplace.buy(listingId);

        assertEq(nft.ownerOf(tokenId), buyer);
        assertEq(nft.activeListingId(tokenId), 0);

        uint256 expectedFee = (PRICE * 250) / 10_000;
        assertEq(usdc.balanceOf(feeRecipient), expectedFee);
        assertEq(usdc.balanceOf(seller), PRICE - expectedFee);
    }

    function test_BuySplitsRoyaltyWhenSet() public {
        address royaltyReceiver = makeAddr("royaltyReceiver");

        vm.warp(block.timestamp + nft.MIN_MINT_INTERVAL());
        vm.prank(curator);
        uint256 collectionId = nft.createCollection(10);

        vm.startPrank(seller);
        uint256 tokenId = nft.mint(collectionId, "ipfs://with-royalty", royaltyReceiver, 500, NO_MAX);
        nft.approve(address(marketplace), tokenId);
        vm.stopPrank();

        vm.prank(curator);
        nft.endMint(collectionId);

        vm.prank(seller);
        uint256 listingId = marketplace.list(tokenId, PRICE);

        vm.prank(buyer);
        marketplace.buy(listingId);

        uint256 expectedFee = (PRICE * 250) / 10_000;
        uint256 expectedRoyalty = (PRICE * 500) / 10_000;
        uint256 expectedSellerProceeds = PRICE - expectedFee - expectedRoyalty;

        assertEq(usdc.balanceOf(feeRecipient), expectedFee);
        assertEq(usdc.balanceOf(royaltyReceiver), expectedRoyalty);
        assertEq(usdc.balanceOf(seller), expectedSellerProceeds);
    }

    function test_RevertWhen_NonAgentBuys() public {
        uint256 tokenId = _mintedTokenId();
        vm.prank(seller);
        uint256 listingId = marketplace.list(tokenId, PRICE);

        vm.prank(randomWallet);
        vm.expectRevert(Marketplace.NotAgent.selector);
        marketplace.buy(listingId);
    }

    function test_CancelListingReturnsNftAndClearsActiveListing() public {
        uint256 tokenId = _mintedTokenId();
        vm.prank(seller);
        uint256 listingId = marketplace.list(tokenId, PRICE);

        vm.prank(seller);
        marketplace.cancelListing(listingId);

        assertEq(nft.ownerOf(tokenId), seller);
        assertEq(nft.activeListingId(tokenId), 0);
    }

    function test_DeregisteredSellerCanStillCancel() public {
        uint256 tokenId = _mintedTokenId();
        vm.prank(seller);
        uint256 listingId = marketplace.list(tokenId, PRICE);

        vm.prank(deployer);
        registry.deregisterAgent(seller);

        vm.prank(seller);
        marketplace.cancelListing(listingId);

        assertEq(nft.ownerOf(tokenId), seller);
    }

    function test_RevertWhen_NonSellerCancels() public {
        uint256 tokenId = _mintedTokenId();
        vm.prank(seller);
        uint256 listingId = marketplace.list(tokenId, PRICE);

        vm.prank(buyer);
        vm.expectRevert(Marketplace.NotSeller.selector);
        marketplace.cancelListing(listingId);
    }

    function test_RevertWhen_ListingPriceZero() public {
        uint256 tokenId = _mintedTokenId();
        vm.prank(seller);
        vm.expectRevert(Marketplace.PriceZero.selector);
        marketplace.list(tokenId, 0);
    }

    function test_RevertWhen_ListingTooSoon() public {
        uint256 firstTokenId = _mintedTokenId();
        uint256 originalTime = block.timestamp;

        uint256 secondTokenId = _prepareSecondListableToken();
        vm.warp(originalTime);

        vm.prank(seller);
        marketplace.list(firstTokenId, PRICE);

        vm.prank(seller);
        vm.expectRevert(Marketplace.ListTooSoon.selector);
        marketplace.list(secondTokenId, PRICE);
    }

    function test_ListSucceedsAfterCooldownElapses() public {
        uint256 firstTokenId = _mintedTokenId();
        vm.prank(seller);
        marketplace.list(firstTokenId, PRICE);

        uint256 secondTokenId = _prepareSecondListableToken();

        vm.prank(seller);
        uint256 listingId = marketplace.list(secondTokenId, PRICE);

        (, bool active, , ) = marketplace.listings(listingId);
        assertTrue(active);
    }

    function test_RevertWhen_ListingBeforeMintPhaseEnds() public {
        vm.warp(block.timestamp + nft.MIN_MINT_INTERVAL());
        vm.prank(curator);
        uint256 collectionId = nft.createCollection(10);

        vm.startPrank(seller);
        uint256 tokenId = nft.mint(collectionId, "ipfs://still-minting", address(0), 0, NO_MAX);
        nft.approve(address(marketplace), tokenId);
        vm.expectRevert(Marketplace.MintNotEnded.selector);
        marketplace.list(tokenId, PRICE);
        vm.stopPrank();
    }

    function test_ListSucceedsOnceCollectionSellsOut() public {
        vm.warp(block.timestamp + nft.MIN_MINT_INTERVAL());
        vm.prank(curator);
        uint256 collectionId = nft.createCollection(1);

        vm.startPrank(seller);
        uint256 tokenId = nft.mint(collectionId, "ipfs://sold-out", address(0), 0, NO_MAX);
        nft.approve(address(marketplace), tokenId);
        marketplace.list(tokenId, PRICE);
        vm.stopPrank();

        assertEq(nft.ownerOf(tokenId), address(marketplace));
    }

    function test_ListSucceedsAfterMintEndedByCurator() public {
        vm.warp(block.timestamp + nft.MIN_MINT_INTERVAL());
        vm.prank(curator);
        uint256 collectionId = nft.createCollection(10);

        vm.startPrank(seller);
        uint256 tokenId = nft.mint(collectionId, "ipfs://ended-early", address(0), 0, NO_MAX);
        nft.approve(address(marketplace), tokenId);
        vm.stopPrank();

        vm.prank(curator);
        nft.endMint(collectionId);

        vm.prank(seller);
        marketplace.list(tokenId, PRICE);

        assertEq(nft.ownerOf(tokenId), address(marketplace));
    }

    function test_DailyActionLimitAllows10CombinedListAndBuyCalls() public {
        vm.prank(seller);
        marketplace.list(_mintedTokenId(), PRICE);

        vm.prank(curator);
        uint256 collectionId = nft.createCollection(15);

        for (uint256 i = 0; i < 9; i++) {
            vm.warp(block.timestamp + nft.MIN_MINT_INTERVAL());
            vm.startPrank(seller);
            uint256 tokenId = nft.mint(collectionId, "ipfs://batch", address(0), 0, NO_MAX);
            nft.approve(address(marketplace), tokenId);
            vm.stopPrank();
        }

        vm.prank(curator);
        nft.endMint(collectionId);

        for (uint256 tokenId = 2; tokenId <= 10; tokenId++) {
            vm.warp(block.timestamp + marketplace.MIN_LIST_INTERVAL());
            vm.prank(seller);
            marketplace.list(tokenId, PRICE);
        }

        assertEq(marketplace.dailyActionCount(seller), 10);
    }

    function test_RevertWhen_11thDailyActionAttempted() public {
        vm.prank(seller);
        marketplace.list(_mintedTokenId(), PRICE);

        vm.prank(curator);
        uint256 collectionId = nft.createCollection(15);

        for (uint256 i = 0; i < 10; i++) {
            vm.warp(block.timestamp + nft.MIN_MINT_INTERVAL());
            vm.startPrank(seller);
            uint256 tokenId = nft.mint(collectionId, "ipfs://batch", address(0), 0, NO_MAX);
            nft.approve(address(marketplace), tokenId);
            vm.stopPrank();
        }

        vm.prank(curator);
        nft.endMint(collectionId);

        for (uint256 tokenId = 2; tokenId <= 10; tokenId++) {
            vm.warp(block.timestamp + marketplace.MIN_LIST_INTERVAL());
            vm.prank(seller);
            marketplace.list(tokenId, PRICE);
        }

        vm.warp(block.timestamp + marketplace.MIN_LIST_INTERVAL());
        vm.prank(seller);
        vm.expectRevert(Marketplace.DailyActionLimitReached.selector);
        marketplace.list(11, PRICE);
    }

    function test_DailyActionLimitResetsNextDay() public {
        vm.prank(seller);
        marketplace.list(_mintedTokenId(), PRICE);
        assertEq(marketplace.dailyActionCount(seller), 1);

        vm.warp(block.timestamp + 1 days);

        uint256 secondTokenId = _prepareSecondListableToken();
        vm.prank(seller);
        marketplace.list(secondTokenId, PRICE);

        assertEq(marketplace.dailyActionCount(seller), 1);
    }

    function test_RevertWhen_ListingWhilePaused() public {
        vm.prank(deployer);
        marketplace.pause();

        vm.prank(seller);
        vm.expectRevert();
        marketplace.list(_mintedTokenId(), PRICE);
    }

    function test_CancelListingStillWorksWhilePaused() public {
        vm.prank(seller);
        uint256 listingId = marketplace.list(_mintedTokenId(), PRICE);

        vm.prank(deployer);
        marketplace.pause();

        vm.prank(seller);
        marketplace.cancelListing(listingId);

        assertEq(nft.ownerOf(_mintedTokenId()), seller);
    }

    function test_PausingMarketplaceAlsoBlocksOffersViaSharedCounter() public {
        vm.prank(deployer);
        marketplace.pause();

        vm.prank(seller);
        vm.expectRevert();
        marketplace.consumeDailyAction(seller);
    }

    function test_RevertWhen_NonOwnerPauses() public {
        vm.prank(seller);
        vm.expectRevert();
        marketplace.pause();
    }

    function test_EmergencyWithdrawNft() public {
        uint256 tokenId = _mintedTokenId();
        vm.prank(seller);
        marketplace.list(tokenId, PRICE);

        vm.prank(deployer);
        marketplace.emergencyWithdrawNft(tokenId, deployer);

        assertEq(nft.ownerOf(tokenId), deployer);
    }

    function test_RevertWhen_NonOwnerEmergencyWithdraws() public {
        uint256 tokenId = _mintedTokenId();
        vm.prank(seller);
        marketplace.list(tokenId, PRICE);

        vm.prank(seller);
        vm.expectRevert();
        marketplace.emergencyWithdrawNft(tokenId, seller);
    }
    function test_RevertWhen_ConstructedWithZeroFeeRecipient() public {
        vm.expectRevert(Marketplace.ZeroAddress.selector);
        new Marketplace(deployer, address(usdc), address(0), address(registry), address(nft));
    }

    function test_RevertWhen_SettingOffersContractToZeroAddress() public {
        vm.prank(deployer);
        vm.expectRevert(Marketplace.ZeroAddress.selector);
        marketplace.setOffersContract(address(0));
    }

    function test_RevertWhen_SettingFeeRecipientToZeroAddress() public {
        vm.prank(deployer);
        vm.expectRevert(Marketplace.ZeroAddress.selector);
        marketplace.setFee(250, address(0));
    }
}