// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {AgentRegistry} from "../src/AgentRegistry.sol";
import {AgentNFT} from "../src/AgentNFT.sol";
import {Marketplace} from "../src/Marketplace.sol";
import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";

/// Minimal mock USDC — real USDC uses a proxy pattern that's overkill to
/// replicate here; a plain ERC20 with 6 decimals is enough to test the
/// Marketplace's fee/royalty math and transfer flows.
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
    // AgentNFT enforces curator != minter — the collection CREATOR (curator)
    // and the wallet that owns/sells the resulting token (seller) must be
    // different agents. `curator` only ever creates collections and calls
    // endMint(); `seller` mints into curator's collections (thereby owning
    // what they mint) and lists/sells on the Marketplace, exactly like a
    // normal seller in the rest of this file.
    address curator = address(0xC0);
    address seller = address(0x5E11E7);
    address buyer = address(0xB0714);
    address randomWallet = address(0xBAD);

    uint256 constant PRICE = 10_000_000; // 10 USDC (6dp)

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

        // curator creates a collection; seller (a DIFFERENT agent — the
        // curator can't mint their own collection) mints into it and
        // thereby owns the resulting token. curator then ends the mint
        // phase — most tests below just need one already-listable token.
        vm.prank(curator);
        uint256 collectionId = nft.createCollection(10);

        vm.startPrank(seller);
        uint256 tokenId = nft.mint(collectionId, "ipfs://example", address(0), 0);
        nft.approve(address(marketplace), tokenId);
        vm.stopPrank();

        vm.prank(curator);
        nft.endMint(collectionId);

        // Buyer needs USDC and must approve the marketplace to spend it.
        usdc.mint(buyer, PRICE);
        vm.prank(buyer);
        usdc.approve(address(marketplace), PRICE);
    }

    function _mintedTokenId() internal pure returns (uint256) {
        return 1; // first token minted in setUp
    }

    /// Helper for tests that need a SECOND, already-mint-ended, listable
    /// token for `seller` — curator creates a fresh collection (no
    /// time-based cooldown between creations anymore, just the weekly
    /// count cap — curator has plenty of headroom in a fresh test), seller
    /// mints into it, curator ends its mint phase, seller approves the
    /// marketplace. Warps time forward by AgentNFT's mint cooldown (10s)
    /// first — clears seller's own mint cooldown from setUp, and happens
    /// to exactly satisfy Marketplace's own 10s list cooldown too, since
    /// both are the same duration.
    function _prepareSecondListableToken() internal returns (uint256 tokenId) {
        vm.warp(block.timestamp + nft.MIN_MINT_INTERVAL());

        vm.prank(curator);
        uint256 collectionId = nft.createCollection(10);

        vm.startPrank(seller);
        tokenId = nft.mint(collectionId, "ipfs://second", address(0), 0);
        nft.approve(address(marketplace), tokenId);
        vm.stopPrank();

        vm.prank(curator);
        nft.endMint(collectionId);
    }

    // --- Core listing/buying/cancelling ---

    function test_ListTransfersNftToEscrowAndSetsActiveListing() public {
        uint256 tokenId = _mintedTokenId();
        vm.prank(seller);
        uint256 listingId = marketplace.list(tokenId, PRICE);

        assertEq(nft.ownerOf(tokenId), address(marketplace));
        assertEq(nft.activeListingId(tokenId), listingId);

        (address listedSeller,, uint256 price, bool active) = marketplace.listings(listingId);
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
        assertEq(nft.activeListingId(tokenId), 0); // cleared after sale

        // No royalty set on this token (royaltyBps=0 at mint), so only
        // the 2.5% default marketplace fee applies.
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
        uint256 tokenId = nft.mint(collectionId, "ipfs://with-royalty", royaltyReceiver, 500); // 5%
        nft.approve(address(marketplace), tokenId);
        vm.stopPrank();

        vm.prank(curator);
        nft.endMint(collectionId);

        vm.prank(seller);
        uint256 listingId = marketplace.list(tokenId, PRICE);

        vm.prank(buyer);
        marketplace.buy(listingId);

        uint256 expectedFee = (PRICE * 250) / 10_000; // 2.5%
        uint256 expectedRoyalty = (PRICE * 500) / 10_000; // 5%
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

        // cancelListing is deliberately not onlyAgent-gated — this must
        // still succeed even after deregistration.
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

    // --- Listing cooldown ---

    function test_RevertWhen_ListingTooSoon() public {
        uint256 firstTokenId = _mintedTokenId();
        uint256 originalTime = block.timestamp;

        // Prepare a second already-mint-ended token via a forward warp
        // (needed to clear AgentNFT's unrelated cooldowns), then warp
        // BACK to the original time so the actual list() attempts below
        // correctly test ONLY Marketplace's own list cooldown, without
        // the prep work incidentally clearing it too.
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

        // _prepareSecondListableToken's warp (30s) exceeds Marketplace's
        // own 10s list cooldown too, so no extra warp needed here.
        uint256 secondTokenId = _prepareSecondListableToken();

        vm.prank(seller);
        uint256 listingId = marketplace.list(secondTokenId, PRICE);

        (, , , bool active) = marketplace.listings(listingId);
        assertTrue(active);
    }

    // --- Mint-phase gate ---

    function test_RevertWhen_ListingBeforeMintPhaseEnds() public {
        vm.warp(block.timestamp + nft.MIN_MINT_INTERVAL());
        vm.prank(curator);
        uint256 collectionId = nft.createCollection(10); // NOT sold out (only 1/10 minted)

        vm.startPrank(seller);
        uint256 tokenId = nft.mint(collectionId, "ipfs://still-minting", address(0), 0);
        nft.approve(address(marketplace), tokenId);
        // Deliberately NOT ended by curator — mint phase still active.
        vm.expectRevert(Marketplace.MintNotEnded.selector);
        marketplace.list(tokenId, PRICE);
        vm.stopPrank();
    }

    function test_ListSucceedsOnceCollectionSellsOut() public {
        vm.warp(block.timestamp + nft.MIN_MINT_INTERVAL());
        vm.prank(curator);
        uint256 collectionId = nft.createCollection(1); // maxSupply=1 — sells out on first mint

        vm.startPrank(seller);
        uint256 tokenId = nft.mint(collectionId, "ipfs://sold-out", address(0), 0);
        nft.approve(address(marketplace), tokenId);
        // No endMint() call needed — selling out already ends the phase.
        marketplace.list(tokenId, PRICE);
        vm.stopPrank();

        assertEq(nft.ownerOf(tokenId), address(marketplace));
    }

    function test_ListSucceedsAfterMintEndedByCurator() public {
        vm.warp(block.timestamp + nft.MIN_MINT_INTERVAL());
        vm.prank(curator);
        uint256 collectionId = nft.createCollection(10);

        vm.startPrank(seller);
        uint256 tokenId = nft.mint(collectionId, "ipfs://ended-early", address(0), 0);
        nft.approve(address(marketplace), tokenId);
        vm.stopPrank();

        vm.prank(curator); // only the CURATOR can end the mint, not seller
        nft.endMint(collectionId);

        vm.prank(seller);
        marketplace.list(tokenId, PRICE);

        assertEq(nft.ownerOf(tokenId), address(marketplace));
    }

    // --- Daily action cap (list + buy share ONE counter, per explicit request) ---

    function test_DailyActionLimitAllows10CombinedListAndBuyCalls() public {
        // setUp already used curator's collection #1/2 for the week and
        // seller's first mint+list slot conceptually — but we haven't
        // LISTED that first token yet in this test, so start fresh: list
        // it as action #1, then mint+list 9 more tokens for actions #2-10.
        vm.prank(seller);
        marketplace.list(_mintedTokenId(), PRICE); // action 1/10

        vm.prank(curator);
        uint256 collectionId = nft.createCollection(15); // curator's 2nd collection this week — still within cap

        for (uint256 i = 0; i < 9; i++) {
            vm.warp(block.timestamp + nft.MIN_MINT_INTERVAL());
            vm.startPrank(seller);
            uint256 tokenId = nft.mint(collectionId, "ipfs://batch", address(0), 0);
            nft.approve(address(marketplace), tokenId);
            vm.stopPrank();
        }

        vm.prank(curator);
        nft.endMint(collectionId);

        // List actions 2 through 10 — the 9 tokens minted above are IDs
        // 2..10 (token 1 was setUp's, already listed as action 1; the
        // loop's tokenIds continue sequentially from there with no gaps).
        for (uint256 tokenId = 2; tokenId <= 10; tokenId++) {
            vm.warp(block.timestamp + marketplace.MIN_LIST_INTERVAL());
            vm.prank(seller);
            marketplace.list(tokenId, PRICE); // actions 2..10
        }

        assertEq(marketplace.dailyActionCount(seller), 10);
    }

    function test_RevertWhen_11thDailyActionAttempted() public {
        vm.prank(seller);
        marketplace.list(_mintedTokenId(), PRICE); // action 1/10

        vm.prank(curator);
        uint256 collectionId = nft.createCollection(15);

        for (uint256 i = 0; i < 10; i++) {
            vm.warp(block.timestamp + nft.MIN_MINT_INTERVAL());
            vm.startPrank(seller);
            uint256 tokenId = nft.mint(collectionId, "ipfs://batch", address(0), 0);
            nft.approve(address(marketplace), tokenId);
            vm.stopPrank();
        }

        vm.prank(curator);
        nft.endMint(collectionId);

        // Actions 2 through 10 (9 more lists). The loop above minted 10
        // tokens (IDs 2..11); this uses the first 9 of them (2..10),
        // leaving token 11 unlisted and available for the 11th attempt.
        for (uint256 tokenId = 2; tokenId <= 10; tokenId++) {
            vm.warp(block.timestamp + marketplace.MIN_LIST_INTERVAL());
            vm.prank(seller);
            marketplace.list(tokenId, PRICE);
        }

        // 11th action, using token 11 — a REAL, already-minted, approved,
        // mint-ended token, so this reverts because of the daily cap
        // specifically, not because the token doesn't exist or its
        // collection is still minting.
        vm.warp(block.timestamp + marketplace.MIN_LIST_INTERVAL());
        vm.prank(seller);
        vm.expectRevert(Marketplace.DailyActionLimitReached.selector);
        marketplace.list(11, PRICE);
    }

    function test_DailyActionLimitResetsNextDay() public {
        vm.prank(seller);
        marketplace.list(_mintedTokenId(), PRICE); // action 1/10
        assertEq(marketplace.dailyActionCount(seller), 1);

        vm.warp(block.timestamp + 1 days);

        uint256 secondTokenId = _prepareSecondListableToken();
        vm.prank(seller);
        marketplace.list(secondTokenId, PRICE);

        // New day — count reset to 1, not accumulated to 2.
        assertEq(marketplace.dailyActionCount(seller), 1);
    }

    // --- Pausable / emergency controls ---

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

        // Deliberately NOT paused — a seller must always be able to
        // reclaim their listed NFT during an emergency.
        vm.prank(seller);
        marketplace.cancelListing(listingId);

        assertEq(nft.ownerOf(_mintedTokenId()), seller);
    }

    function test_PausingMarketplaceAlsoBlocksOffersViaSharedCounter() public {
        // consumeDailyAction is also whenNotPaused — proves a paused
        // Marketplace cascades to block Offers trades too, since Offers
        // routes through this shared function.
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
        marketplace.list(tokenId, PRICE); // NFT now escrowed in Marketplace

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
}
