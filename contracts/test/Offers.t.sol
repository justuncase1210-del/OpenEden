// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {AgentRegistry} from "../src/AgentRegistry.sol";
import {AgentNFT} from "../src/AgentNFT.sol";
import {Marketplace} from "../src/Marketplace.sol";
import {Offers} from "../src/Offers.sol";
import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";

contract MockUSDC is ERC20 {
    constructor() ERC20("Mock USDC", "USDC") {}
    function decimals() public pure override returns (uint8) { return 6; }
    function mint(address to, uint256 amount) external { _mint(to, amount); }
}

contract OffersTest is Test {
    AgentRegistry registry;
    AgentNFT nft;
    Marketplace marketplace;
    Offers offersContract;
    MockUSDC usdc;

    address deployer = address(0xA11CE);
    address feeRecipient = address(0xFEE);
    address curator = address(0xC0);
    address owner_ = makeAddr("owner");
    address offerer = makeAddr("offerer");
    address randomWallet = address(0xBAD);

    uint256 constant OFFER_AMOUNT = 8_000_000;
    uint256 constant NO_MAX = type(uint256).max;
    uint256 tokenId;

    function setUp() public {
        vm.warp(100);
        vm.startPrank(deployer);
        registry = new AgentRegistry(deployer);
        usdc = new MockUSDC();
        nft = new AgentNFT(deployer, address(registry), address(usdc));
        marketplace = new Marketplace(deployer, address(usdc), feeRecipient, address(registry), address(nft));
        nft.setMarketplace(address(marketplace));
        offersContract = new Offers(deployer, address(usdc), address(registry), address(nft), address(marketplace));
        marketplace.setOffersContract(address(offersContract));

        registry.registerAgent(curator, "agent-curator");
        registry.registerAgent(owner_, "agent-owner");
        registry.registerAgent(offerer, "agent-offerer");
        vm.stopPrank();

        vm.prank(curator);
        uint256 collectionId = nft.createCollection(10);

        vm.startPrank(owner_);
        tokenId = nft.mint(collectionId, "ipfs://example", address(0), 0, NO_MAX);
        vm.stopPrank();

        vm.prank(curator);
        nft.endMint(collectionId);

        usdc.mint(offerer, 1_000_000_000);
        vm.prank(offerer);
        usdc.approve(address(offersContract), type(uint256).max);
    }

    function test_MakeOfferEscrowsUsdc() public {
        uint256 offererBalanceBefore = usdc.balanceOf(offerer);

        vm.prank(offerer);
        uint256 offerId = offersContract.makeOffer(tokenId, OFFER_AMOUNT, 7 days);

        assertEq(usdc.balanceOf(offerer), offererBalanceBefore - OFFER_AMOUNT);
        assertEq(usdc.balanceOf(address(offersContract)), OFFER_AMOUNT);

        (address offerAddr, bool active, uint256 offerTokenId, uint256 amount, ) = offersContract.offers(offerId);
        assertEq(offerAddr, offerer);
        assertEq(offerTokenId, tokenId);
        assertEq(amount, OFFER_AMOUNT);
        assertTrue(active);
    }

    function test_RevertWhen_NonAgentMakesOffer() public {
        vm.prank(randomWallet);
        vm.expectRevert(Offers.NotAgent.selector);
        offersContract.makeOffer(tokenId, OFFER_AMOUNT, 7 days);
    }

    function test_RevertWhen_OfferAmountZero() public {
        vm.prank(offerer);
        vm.expectRevert(Offers.AmountZero.selector);
        offersContract.makeOffer(tokenId, 0, 7 days);
    }

    function test_RevertWhen_DurationExceedsMax() public {
        vm.prank(offerer);
        vm.expectRevert(Offers.DurationTooLong.selector);
        offersContract.makeOffer(tokenId, OFFER_AMOUNT, 31 days);
    }

    function test_CancelOfferRefundsEscrow() public {
        vm.prank(offerer);
        uint256 offerId = offersContract.makeOffer(tokenId, OFFER_AMOUNT, 7 days);

        uint256 balanceBeforeCancel = usdc.balanceOf(offerer);
        vm.prank(offerer);
        offersContract.cancelOffer(offerId);

        assertEq(usdc.balanceOf(offerer), balanceBeforeCancel + OFFER_AMOUNT);
        (, bool active, , , ) = offersContract.offers(offerId);
        assertFalse(active);
    }

    function test_RevertWhen_NonOffererCancels() public {
        vm.prank(offerer);
        uint256 offerId = offersContract.makeOffer(tokenId, OFFER_AMOUNT, 7 days);

        vm.prank(owner_);
        vm.expectRevert(Offers.NotOfferer.selector);
        offersContract.cancelOffer(offerId);
    }

    function test_DeregisteredOffererCanStillCancel() public {
        vm.prank(offerer);
        uint256 offerId = offersContract.makeOffer(tokenId, OFFER_AMOUNT, 7 days);

        vm.prank(deployer);
        registry.deregisterAgent(offerer);

        vm.prank(offerer);
        offersContract.cancelOffer(offerId);

        (, bool active, , , ) = offersContract.offers(offerId);
        assertFalse(active);
    }

    function test_AcceptOfferTransfersNftAndSplitsPaymentNoRoyalty() public {
        vm.prank(offerer);
        uint256 offerId = offersContract.makeOffer(tokenId, OFFER_AMOUNT, 7 days);

        vm.prank(owner_);
        nft.approve(address(offersContract), tokenId);

        vm.prank(owner_);
        offersContract.acceptOffer(offerId);

        assertEq(nft.ownerOf(tokenId), offerer);

        uint256 expectedFee = (OFFER_AMOUNT * marketplace.feeBps()) / 10_000;
        assertEq(usdc.balanceOf(feeRecipient), expectedFee);
        assertEq(usdc.balanceOf(owner_), OFFER_AMOUNT - expectedFee);
    }

    function test_AcceptOfferSplitsRoyaltyWhenSet() public {
        address royaltyReceiver = makeAddr("royaltyReceiver");

        vm.warp(block.timestamp + nft.MIN_MINT_INTERVAL());
        vm.prank(curator);
        uint256 collectionId = nft.createCollection(10);

        vm.startPrank(owner_);
        uint256 royaltyTokenId = nft.mint(collectionId, "ipfs://with-royalty", royaltyReceiver, 500, NO_MAX);
        vm.stopPrank();

        vm.prank(curator);
        nft.endMint(collectionId);

        vm.prank(offerer);
        uint256 offerId = offersContract.makeOffer(royaltyTokenId, OFFER_AMOUNT, 7 days);

        vm.prank(owner_);
        nft.approve(address(offersContract), royaltyTokenId);

        vm.prank(owner_);
        offersContract.acceptOffer(offerId);

        uint256 expectedFee = (OFFER_AMOUNT * marketplace.feeBps()) / 10_000;
        uint256 expectedRoyalty = (OFFER_AMOUNT * 500) / 10_000;
        uint256 expectedSellerProceeds = OFFER_AMOUNT - expectedFee - expectedRoyalty;

        assertEq(usdc.balanceOf(feeRecipient), expectedFee);
        assertEq(usdc.balanceOf(royaltyReceiver), expectedRoyalty);
        assertEq(usdc.balanceOf(owner_), expectedSellerProceeds);
    }

    function test_RevertWhen_RegisteredNonOwnerAcceptsOffer() public {
        vm.prank(offerer);
        uint256 offerId = offersContract.makeOffer(tokenId, OFFER_AMOUNT, 7 days);

        vm.prank(curator);
        vm.expectRevert(Offers.NotTokenOwner.selector);
        offersContract.acceptOffer(offerId);
    }

    function test_RevertWhen_AcceptingExpiredOffer() public {
        vm.prank(offerer);
        uint256 offerId = offersContract.makeOffer(tokenId, OFFER_AMOUNT, 1 days);

        vm.warp(block.timestamp + 2 days);

        vm.prank(owner_);
        vm.expectRevert(Offers.OfferExpired.selector);
        offersContract.acceptOffer(offerId);
    }

    function test_RevertWhen_AcceptingBeforeMintPhaseEnds() public {
        vm.warp(block.timestamp + nft.MIN_MINT_INTERVAL());
        vm.prank(curator);
        uint256 collectionId = nft.createCollection(10);

        vm.startPrank(owner_);
        uint256 activeTokenId = nft.mint(collectionId, "ipfs://still-minting", address(0), 0, NO_MAX);
        vm.stopPrank();

        vm.prank(offerer);
        uint256 offerId = offersContract.makeOffer(activeTokenId, OFFER_AMOUNT, 7 days);

        vm.prank(owner_);
        vm.expectRevert(Offers.MintNotEnded.selector);
        offersContract.acceptOffer(offerId);
    }

    function test_RevertWhen_OriginalOwnerAcceptsAfterSellingElsewhere() public {
        vm.prank(offerer);
        uint256 offerId = offersContract.makeOffer(tokenId, OFFER_AMOUNT, 7 days);

        usdc.mint(curator, 5_000_000);
        vm.prank(curator);
        usdc.approve(address(marketplace), 5_000_000);

        vm.prank(owner_);
        nft.approve(address(marketplace), tokenId);
        vm.prank(owner_);
        uint256 listingId = marketplace.list(tokenId, 5_000_000);
        vm.prank(curator);
        marketplace.buy(listingId);

        assertEq(nft.ownerOf(tokenId), curator);

        vm.prank(owner_);
        vm.expectRevert(Offers.NotTokenOwner.selector);
        offersContract.acceptOffer(offerId);
    }

    function test_NewOwnerInheritsAbilityToAcceptExistingOffer() public {
        vm.prank(offerer);
        uint256 offerId = offersContract.makeOffer(tokenId, OFFER_AMOUNT, 7 days);

        usdc.mint(curator, 5_000_000);
        vm.prank(curator);
        usdc.approve(address(marketplace), 5_000_000);

        vm.prank(owner_);
        nft.approve(address(marketplace), tokenId);
        vm.prank(owner_);
        uint256 listingId = marketplace.list(tokenId, 5_000_000);
        vm.prank(curator);
        marketplace.buy(listingId);

        vm.prank(curator);
        nft.approve(address(offersContract), tokenId);

        vm.prank(curator);
        offersContract.acceptOffer(offerId);

        assertEq(nft.ownerOf(tokenId), offerer);
    }

    function test_MakeOfferAndListShareTheSameDailyCounter() public {
        vm.prank(owner_);
        nft.approve(address(marketplace), tokenId);
        vm.prank(owner_);
        marketplace.list(tokenId, 5_000_000);

        assertEq(marketplace.dailyActionCount(owner_), 1);

        vm.warp(block.timestamp + nft.MIN_MINT_INTERVAL());
        vm.prank(curator);
        uint256 collectionId = nft.createCollection(10);
        vm.prank(offerer);
        uint256 secondTokenId = nft.mint(collectionId, "ipfs://second", address(0), 0, NO_MAX);
        vm.prank(curator);
        nft.endMint(collectionId);

        usdc.mint(owner_, OFFER_AMOUNT);
        vm.prank(owner_);
        usdc.approve(address(offersContract), OFFER_AMOUNT);
        vm.prank(owner_);
        offersContract.makeOffer(secondTokenId, OFFER_AMOUNT, 7 days);

        assertEq(marketplace.dailyActionCount(owner_), 2);
    }

    function test_RevertWhen_SharedDailyCapReachedViaOffers() public {
        vm.prank(curator);
        uint256 collectionId = nft.createCollection(15);

        uint256[] memory ids = new uint256[](9);

        for (uint256 i = 0; i < 9; i++) {
            vm.warp(block.timestamp + nft.MIN_MINT_INTERVAL());
            vm.prank(owner_);
            ids[i] = nft.mint(collectionId, "ipfs://batch", address(0), 0, NO_MAX);
        }

        vm.prank(curator);
        nft.endMint(collectionId);

        for (uint256 i = 0; i < 9; i++) {
            vm.prank(owner_);
            nft.approve(address(marketplace), ids[i]);

            vm.warp(block.timestamp + marketplace.MIN_LIST_INTERVAL());

            vm.prank(owner_);
            marketplace.list(ids[i], 1_000_000);
        }
        assertEq(marketplace.dailyActionCount(owner_), 9);

        usdc.mint(owner_, 10 * OFFER_AMOUNT);
        vm.prank(owner_);
        usdc.approve(address(offersContract), type(uint256).max);

        vm.prank(owner_);
        offersContract.makeOffer(tokenId, OFFER_AMOUNT, 7 days);
        assertEq(marketplace.dailyActionCount(owner_), 10);

        vm.warp(block.timestamp + nft.MIN_MINT_INTERVAL());
        vm.prank(owner_);
        uint256 secondCollectionId = nft.createCollection(5);
        vm.prank(offerer);
        uint256 anotherTokenId = nft.mint(secondCollectionId, "ipfs://another", address(0), 0, NO_MAX);
        vm.prank(owner_);
        nft.endMint(secondCollectionId);

        vm.prank(owner_);
        vm.expectRevert(Marketplace.DailyActionLimitReached.selector);
        offersContract.makeOffer(anotherTokenId, OFFER_AMOUNT, 7 days);
    }

    function test_RevertWhen_MakingOfferWhilePaused() public {
        vm.prank(deployer);
        offersContract.pause();

        vm.prank(offerer);
        vm.expectRevert();
        offersContract.makeOffer(tokenId, OFFER_AMOUNT, 7 days);
    }

    function test_CancelOfferStillWorksWhilePaused() public {
        vm.prank(offerer);
        uint256 offerId = offersContract.makeOffer(tokenId, OFFER_AMOUNT, 7 days);

        vm.prank(deployer);
        offersContract.pause();

        vm.prank(offerer);
        offersContract.cancelOffer(offerId);

        (, bool active, , , ) = offersContract.offers(offerId);
        assertFalse(active);
    }

    function test_UnpauseRestoresMakeOffer() public {
        vm.prank(deployer);
        offersContract.pause();
        vm.prank(deployer);
        offersContract.unpause();

        vm.prank(offerer);
        uint256 offerId = offersContract.makeOffer(tokenId, OFFER_AMOUNT, 7 days);
        (, bool active, , , ) = offersContract.offers(offerId);
        assertTrue(active);
    }

    function test_RevertWhen_NonOwnerPauses() public {
        vm.prank(offerer);
        vm.expectRevert();
        offersContract.pause();
    }

    function test_EmergencyWithdrawUsdc() public {
        vm.prank(offerer);
        offersContract.makeOffer(tokenId, OFFER_AMOUNT, 7 days);

        uint256 deployerBalanceBefore = usdc.balanceOf(deployer);
        vm.prank(deployer);
        offersContract.emergencyWithdrawUsdc(deployer, OFFER_AMOUNT);

        assertEq(usdc.balanceOf(deployer), deployerBalanceBefore + OFFER_AMOUNT);
    }

    function test_RevertWhen_NonOwnerEmergencyWithdraws() public {
        vm.prank(offerer);
        vm.expectRevert();
        offersContract.emergencyWithdrawUsdc(offerer, 1);
    }

    function testFuzz_MakeThenCancelOfferAlwaysReturnsExactAmount(uint256 amount) public {
        amount = bound(amount, 1, 1_000_000_000);
        usdc.mint(offerer, amount);
        vm.prank(offerer);
        usdc.approve(address(offersContract), amount);

        uint256 balanceBefore = usdc.balanceOf(offerer);
        vm.prank(offerer);
        uint256 offerId = offersContract.makeOffer(tokenId, amount, 7 days);
        assertEq(usdc.balanceOf(offerer), balanceBefore - amount);

        vm.prank(offerer);
        offersContract.cancelOffer(offerId);
        assertEq(usdc.balanceOf(offerer), balanceBefore);
    }
    function test_RevertWhen_ConstructedWithZeroMarketplace() public {
        vm.expectRevert(Offers.ZeroAddress.selector);
        new Offers(deployer, address(usdc), address(registry), address(nft), address(0));
    }
}