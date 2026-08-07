// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {AgentRegistry} from "../src/AgentRegistry.sol";
import {CommunityRegistry} from "../src/CommunityRegistry.sol";

contract CommunityRegistryTest is Test {
    AgentRegistry registry;
    CommunityRegistry communityRegistry;

    address deployer = address(0xA11CE);
    address agentWallet = address(0xB0B);
    address randomWallet = address(0xBAD);

    function setUp() public {
        vm.warp(100);
        vm.startPrank(deployer);
        registry = new AgentRegistry(deployer);
        communityRegistry = new CommunityRegistry(address(registry));
        registry.registerAgent(agentWallet, "agent-123");
        vm.stopPrank();
    }

    function test_CreateCommunitySetsCreatorAndAutoJoins() public {
        vm.prank(agentWallet);
        communityRegistry.createCommunity("my-community");

        (string memory slug, address creator, string memory creatorAgentId,) = communityRegistry.communities(keccak256(bytes("my-community")));
        assertEq(slug, "my-community");
        assertEq(creator, agentWallet);
        assertEq(creatorAgentId, "agent-123"); // derived from registry, not a param
        assertTrue(communityRegistry.isMember(keccak256(bytes("my-community")), agentWallet));
        assertEq(communityRegistry.memberCount(keccak256(bytes("my-community"))), 1);
    }

    function test_RevertWhen_NonAgentCreates() public {
        vm.prank(randomWallet);
        vm.expectRevert(CommunityRegistry.NotAgent.selector);
        communityRegistry.createCommunity("my-community");
    }

    function test_RevertWhen_DuplicateSlug() public {
        vm.prank(agentWallet);
        communityRegistry.createCommunity("my-community");

        vm.warp(block.timestamp + communityRegistry.MIN_CREATE_INTERVAL());
        vm.prank(agentWallet);
        vm.expectRevert(CommunityRegistry.AlreadyExists.selector);
        communityRegistry.createCommunity("my-community");
    }

    function test_RevertWhen_CreatingTooSoon() public {
        vm.prank(agentWallet);
        communityRegistry.createCommunity("first-community");

        vm.prank(agentWallet);
        vm.expectRevert(CommunityRegistry.CreateTooSoon.selector);
        communityRegistry.createCommunity("second-community");
    }

    function test_CreateSucceedsAfterCooldownElapses() public {
        vm.prank(agentWallet);
        communityRegistry.createCommunity("first-community");

        vm.warp(block.timestamp + communityRegistry.MIN_CREATE_INTERVAL());

        vm.prank(agentWallet);
        communityRegistry.createCommunity("second-community");

        assertTrue(communityRegistry.isMember(keccak256(bytes("second-community")), agentWallet));
    }

    function test_JoinAndLeave() public {
        address secondAgent = address(0xC0FFEE);
        vm.prank(deployer);
        registry.registerAgent(secondAgent, "agent-456");

        vm.prank(agentWallet);
        communityRegistry.createCommunity("shared-community");

        vm.prank(secondAgent);
        communityRegistry.join("shared-community");
        assertEq(communityRegistry.memberCount(keccak256(bytes("shared-community"))), 2);

        vm.prank(secondAgent);
        communityRegistry.leave("shared-community");
        assertEq(communityRegistry.memberCount(keccak256(bytes("shared-community"))), 1);
        assertFalse(communityRegistry.isMember(keccak256(bytes("shared-community")), secondAgent));
    }

    function test_DeregisteredMemberCanStillLeave() public {
        vm.prank(agentWallet);
        communityRegistry.createCommunity("my-community");

        vm.prank(deployer);
        registry.deregisterAgent(agentWallet);

        // leave() is deliberately not onlyAgent-gated — must still work
        // after deregistration.
        vm.prank(agentWallet);
        communityRegistry.leave("my-community");
        assertFalse(communityRegistry.isMember(keccak256(bytes("my-community")), agentWallet));
    }
}
