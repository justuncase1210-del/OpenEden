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

/// A "handler" contract — Foundry's invariant fuzzer calls these public
/// functions randomly, in random order, many times in a row, then checks
/// the invariant after each sequence. It only calls makeOffer/cancelOffer
/// here (not acceptOffer) deliberately — this specific invariant is about
/// escrow bookkeeping staying correct through the make/cancel lifecycle,
/// not the full accept-and-payout flow, which has its own dedicated tests
/// already in Offers.t.sol.
contract OffersHandler is Test {
    Offers public offersContract;
    MockUSDC public usdc;
    address public offerer;
    uint256 public tokenId;

    uint256 public sumOfActiveOffers; // ground truth we track ourselves, to compare against the contract's real balance
    uint256[] public activeOfferIds;

    constructor(Offers _offers, MockUSDC _usdc, address _offerer, uint256 _tokenId) {
        offersContract = _offers;
        usdc = _usdc;
        offerer = _offerer;
        tokenId = _tokenId;
    }

    function makeOffer(uint256 amountSeed) public {
        uint256 amount = bound(amountSeed, 1, 1_000_000_000); // up to 1,000 USDC
        usdc.mint(offerer, amount);
        vm.prank(offerer);
        usdc.approve(address(offersContract), amount);
        vm.prank(offerer);
        uint256 offerId = offersContract.makeOffer(tokenId, amount, 7 days);

        sumOfActiveOffers += amount;
        activeOfferIds.push(offerId);
    }

    function cancelRandomOffer(uint256 indexSeed) public {
        if (activeOfferIds.length == 0) return; // nothing to cancel yet — skip, don't revert the whole run
        uint256 index = indexSeed % activeOfferIds.length;
        uint256 offerId = activeOfferIds[index];

        (, , uint256 amount, , bool active) = offersContract.offers(offerId);
        if (!active) return; // already cancelled in an earlier call this run

        vm.prank(offerer);
        offersContract.cancelOffer(offerId);

        sumOfActiveOffers -= amount;
        activeOfferIds[index] = activeOfferIds[activeOfferIds.length - 1];
        activeOfferIds.pop();
    }
}

contract OffersInvariantTest is Test {
    AgentRegistry registry;
    AgentNFT nft;
    Marketplace marketplace;
    Offers offersContract;
    MockUSDC usdc;
    OffersHandler handler;

    address deployer = address(0xA11CE);
    address feeRecipient = address(0xFEE);
    address curator = address(0xC0);
    address owner_ = makeAddr("owner");
    address offerer = makeAddr("offerer");

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
        vm.prank(owner_);
        uint256 tokenId = nft.mint(collectionId, "ipfs://example", address(0), 0);
        vm.prank(curator);
        nft.endMint(collectionId);

        handler = new OffersHandler(offersContract, usdc, offerer, tokenId);

        // Tell Foundry to ONLY call functions on the handler during
        // invariant runs — not on offersContract/nft/etc. directly. This
        // keeps every call going through realistic, properly-set-up
        // paths (approvals, valid tokenIds) instead of the fuzzer trying
        // truly random garbage against the real contracts.
        targetContract(address(handler));
    }

    /// THE actual invariant: what the contract genuinely holds in USDC
    /// must always exactly match what we believe is escrowed, no matter
    /// what sequence of makeOffer/cancelOffer calls got us here.
    function invariant_EscrowedBalanceMatchesActiveOffers() public view {
        assertEq(usdc.balanceOf(address(offersContract)), handler.sumOfActiveOffers());
    }
}