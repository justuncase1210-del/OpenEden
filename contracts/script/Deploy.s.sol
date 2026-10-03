// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Script, console} from "forge-std/Script.sol";
import {AgentRegistry} from "../src/AgentRegistry.sol";
import {AgentNFT} from "../src/AgentNFT.sol";
import {Marketplace} from "../src/Marketplace.sol";
import {Offers} from "../src/Offers.sol";
import {CommunityRegistry} from "../src/CommunityRegistry.sol";

/// @notice Deploys all five contracts in the correct order. AgentRegistry
///         must deploy FIRST — Marketplace and CommunityRegistry both take
///         its address in their constructors for hard on-chain agent-only
///         enforcement. Offers deploys AFTER Marketplace (needs its
///         address to read fee config and call consumeDailyAction), then
///         Marketplace.setOffersContract() completes the cross-trust —
///         same two-step wiring pattern as AgentNFT.setMarketplace().
/// Usage:
///   forge script script/Deploy.s.sol --rpc-url $BASE_SEPOLIA_RPC_URL \
///     --broadcast --verify -vvvv
contract Deploy is Script {
    // Base Sepolia USDC — verify this is still current before deploying:
    // https://docs.base.org/base-contracts (search "USDC")
    address constant BASE_SEPOLIA_USDC = 0x036CbD53842c5426634e7929541eC2318f3dCF7e;

    function run() external {
        uint256 deployerKey = vm.envUint("DEPLOYER_PRIVATE_KEY");
        address deployer = vm.addr(deployerKey);

        vm.startBroadcast(deployerKey);

        AgentRegistry registry = new AgentRegistry(deployer);
        console.log("AgentRegistry deployed at:", address(registry));

        AgentNFT nft = new AgentNFT(deployer, address(registry), BASE_SEPOLIA_USDC);
        console.log("AgentNFT deployed at:", address(nft));

        // Platform fees go to the OWNER (treasury) address - NOT the throwaway deployer key.
        address admin = vm.envOr("OWNER_ADDRESS", deployer);
        Marketplace marketplace = new Marketplace(deployer, BASE_SEPOLIA_USDC, admin, address(registry), address(nft));
        console.log("Marketplace deployed at:", address(marketplace));

        nft.setMarketplace(address(marketplace));
        console.log("AgentNFT.marketplace set to Marketplace address");

        Offers offers = new Offers(deployer, BASE_SEPOLIA_USDC, address(registry), address(nft), address(marketplace));
        console.log("Offers deployed at:", address(offers));

        marketplace.setOffersContract(address(offers));
        console.log("Marketplace.offersContract set to Offers address");

        CommunityRegistry communityRegistry = new CommunityRegistry(address(registry));
        console.log("CommunityRegistry deployed at:", address(communityRegistry));

        // Optional ERC-7572 contract metadata, e.g. https://<backend>/api/contract-metadata
        // (must be set while the deployer still owns the contract).
        string memory contractUri = vm.envOr("CONTRACT_URI", string(""));
        if (bytes(contractUri).length > 0) nft.setContractURI(contractUri);

        // KEY SEPARATION. The backend relayer only needs AgentRegistry.registerAgent,
        // so ONLY the registry goes to the relayer. NFT / Marketplace / Offers (user
        // escrow + fee config) go to OWNER_ADDRESS - use a multisig. Everything is
        // Ownable2Step: the new owner must call acceptOwnership().
        address relayer = vm.envOr("RELAYER_ADDRESS", deployer);
        if (relayer != deployer) registry.transferOwnership(relayer);
        if (admin != deployer) {
            nft.transferOwnership(admin);
            marketplace.transferOwnership(admin);
            offers.transferOwnership(admin);
        }

        vm.stopBroadcast();

        console.log("\n--- Copy these into backend/.env ---");
        console.log("AGENT_REGISTRY_ADDRESS=", address(registry));
        console.log("NFT_CONTRACT_ADDRESS=", address(nft));
        console.log("MARKETPLACE_CONTRACT_ADDRESS=", address(marketplace));
        console.log("OFFERS_CONTRACT_ADDRESS=", address(offers));
        console.log("COMMUNITY_REGISTRY_ADDRESS=", address(communityRegistry));
        console.log("\nOWNERSHIP (Ownable2Step - pending until each new owner calls acceptOwnership):");
        console.log("  AgentRegistry -> RELAYER_ADDRESS (the backend relayer key)");
        console.log("  AgentNFT / Marketplace / Offers -> OWNER_ADDRESS (use a multisig)");
        console.log("Set RELAYER_PRIVATE_KEY in backend/.env to the RELAYER key ONLY - never the admin key.");
    }
}
