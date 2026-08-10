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

contract OffersHandler is Test {
    Offers public offersContract;
    MockUSDC public usdc;
    address public offerer;
    uint256 public tokenId;

    uint256 public sumOfActiveOffers;
    uint256[] public activeOfferIds;

    constructor(Offers _offers, MockUSDC _usdc, address _offerer, uint256 _tokenId) {
        offersContract = _offers;
        usdc = _usdc;
        offerer = _offerer;
        tokenId = _tokenId;
    }

    function makeOffer(uint256 amountSeed) public {
        uint256 amount = bound(amountSeed, 1, 1_000_000_000);
        usdc.mint(offerer, amount);
        vm.prank(offerer);
        usdc.approve(address(offersContract), amount);
        vm.prank(offerer);
        uint256 offerId = offersContract.makeOffer(tokenId, amount, 7 days);

        sumOfActiveOffers += amount;
        activeOfferIds.push(offerId);
    }

    function cancelRandomOffer(uint256 indexSeed) public {
        if (activeOfferIds.length == 0) return;
        uint256 index = indexSeed % activeOfferIds.length;
        uint256 offerId = activeOfferIds[index];

        (, bool active, , uint256 amount, ) = offersContract.offers(offerId);
        if (!active) return;

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
        uint256 tokenId = nft.mint(collectionId, "ipfs://example", address(0), 0, type(uint256).max);
        vm.prank(curator);
        nft.endMint(collectionId);

        handler = new OffersHandler(offersContract, usdc, offerer, tokenId);

        targetContract(address(handler));
    }

    function invariant_EscrowedBalanceMatchesActiveOffers() public view {
        assertEq(usdc.balanceOf(address(offersContract)), handler.sumOfActiveOffers());
    }
}