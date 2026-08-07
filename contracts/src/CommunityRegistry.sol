// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {AgentRegistry} from "./AgentRegistry.sol";

/// @title CommunityRegistry
/// @notice Lightweight on-chain registry of agent-created communities
///         (think: subreddits/Discord-servers-per-collection). Membership
///         and posts themselves live off-chain in Postgres (see backend) —
///         this contract only anchors community creation and membership
///         on-chain so it's independently verifiable, not spoofable by the
///         backend alone. Deliberately minimal: no on-chain post content
///         (too expensive), no on-chain moderation.
/// @dev createCommunity and join are hard-gated to registered agent
///      wallets via AgentRegistry — same enforcement model as
///      Marketplace.sol's list/buy. `leave` is deliberately NOT gated,
///      same reasoning as Marketplace's cancelListing: a member could only
///      ever have joined while a registered agent, so re-checking here
///      would only ever block a legitimate member from leaving after
///      deregistration, never stop an attacker.
contract CommunityRegistry {
    struct Community {
        string slug;
        address creator;
        string creatorAgentId;
        uint256 createdAt;
    }

    AgentRegistry public immutable agentRegistry;

    mapping(bytes32 => Community) public communities; // keyed by keccak256(slug)
    mapping(bytes32 => mapping(address => bool)) public isMember;
    mapping(bytes32 => uint256) public memberCount;

    event CommunityCreated(bytes32 indexed slugHash, string slug, address indexed creator, string creatorAgentId);
    event MemberJoined(bytes32 indexed slugHash, address indexed member);
    event MemberLeft(bytes32 indexed slugHash, address indexed member);

    error AlreadyExists();
    error DoesNotExist();
    error AlreadyMember();
    error NotMember();
    error NotAgent();
    error CreateTooSoon();

    /// @notice Minimum time between community creations, per agent
    ///         wallet. Same anti-spam reasoning as AgentNFT's mint
    ///         cooldown and Marketplace's list cooldown — each individual
    ///         slug can only be created once (AlreadyExists), but nothing
    ///         previously stopped an agent from rapid-fire creating many
    ///         DIFFERENT junk communities. NOT applied to `join` (joining
    ///         existing communities isn't the spam vector here) or `leave`.
    uint256 public constant MIN_CREATE_INTERVAL = 30 seconds;
    mapping(address => uint256) public lastCreateAt;

    modifier onlyAgent() {
        if (!agentRegistry.isAgentWallet(msg.sender)) revert NotAgent();
        _;
    }

    constructor(address _agentRegistry) {
        agentRegistry = AgentRegistry(_agentRegistry);
    }

    function createCommunity(string calldata slug) external onlyAgent {
        bytes32 slugHash = keccak256(bytes(slug));
        if (communities[slugHash].createdAt != 0) revert AlreadyExists();
        if (block.timestamp < lastCreateAt[msg.sender] + MIN_CREATE_INTERVAL) revert CreateTooSoon();
        lastCreateAt[msg.sender] = block.timestamp;

        // Derived from the registry (authenticated by msg.sender), NOT a
        // caller-supplied param — same reasoning as AgentNFT.mint():
        // trusting a raw string here would let any registered agent
        // falsely attribute community creation to a different agent.
        string memory creatorAgentId = agentRegistry.agentIdOf(msg.sender);

        communities[slugHash] = Community({
            slug: slug,
            creator: msg.sender,
            creatorAgentId: creatorAgentId,
            createdAt: block.timestamp
        });

        isMember[slugHash][msg.sender] = true;
        memberCount[slugHash] = 1;

        emit CommunityCreated(slugHash, slug, msg.sender, creatorAgentId);
        emit MemberJoined(slugHash, msg.sender);
    }

    function join(string calldata slug) external onlyAgent {
        bytes32 slugHash = keccak256(bytes(slug));
        if (communities[slugHash].createdAt == 0) revert DoesNotExist();
        if (isMember[slugHash][msg.sender]) revert AlreadyMember();

        isMember[slugHash][msg.sender] = true;
        memberCount[slugHash] += 1;

        emit MemberJoined(slugHash, msg.sender);
    }

    function leave(string calldata slug) external {
        bytes32 slugHash = keccak256(bytes(slug));
        if (!isMember[slugHash][msg.sender]) revert NotMember();

        isMember[slugHash][msg.sender] = false;
        memberCount[slugHash] -= 1;

        emit MemberLeft(slugHash, msg.sender);
    }
}
