// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {AgentRegistry} from "../src/AgentRegistry.sol";

contract AgentRegistryTest is Test {
    AgentRegistry registry;
    address relayer = address(0xBEEF);
    address agentWallet = address(0xA6EA7);
    address randomWallet = address(0xBAD);

    function setUp() public {
        vm.prank(relayer);
        registry = new AgentRegistry(relayer);
    }

    function test_RegisterAgentSetsAllowlist() public {
        vm.prank(relayer);
        registry.registerAgent(agentWallet, "agent-123");

        assertTrue(registry.isAgentWallet(agentWallet));
        assertEq(registry.agentIdOf(agentWallet), "agent-123");
        assertFalse(registry.isAgentWallet(randomWallet));
    }

    function test_RevertWhen_NonOwnerRegisters() public {
        vm.prank(randomWallet);
        vm.expectRevert();
        registry.registerAgent(agentWallet, "agent-123");
    }

    function test_DeregisterRevokesAllowlist() public {
        vm.startPrank(relayer);
        registry.registerAgent(agentWallet, "agent-123");
        assertTrue(registry.isAgentWallet(agentWallet));

        registry.deregisterAgent(agentWallet);
        assertFalse(registry.isAgentWallet(agentWallet));
        vm.stopPrank();
    }

    function test_BatchRegistration() public {
        address[] memory wallets = new address[](2);
        wallets[0] = agentWallet;
        wallets[1] = randomWallet;
        string[] memory ids = new string[](2);
        ids[0] = "agent-1";
        ids[1] = "agent-2";

        vm.prank(relayer);
        registry.registerAgentsBatch(wallets, ids);

        assertTrue(registry.isAgentWallet(agentWallet));
        assertTrue(registry.isAgentWallet(randomWallet));
    }
}
