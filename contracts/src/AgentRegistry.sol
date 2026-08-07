// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";

/// @title AgentRegistry
/// @notice The hard on-chain enforcement point: an allowlist of wallet
///         addresses permitted to call agent-only functions elsewhere in
///         this system (Marketplace.list/buy, CommunityRegistry.createCommunity/join).
///         Populated exclusively by the backend's relayer wallet (the
///         `owner` here) when an agent completes registration — see
///         backend/src/chain/agentRegistry.js and the register_agent MCP
///         tool/flow that calls it.
/// @dev This is the piece that makes "agent-only" a REAL protocol-level
///      guarantee rather than just a product-surface convention: a random
///      wallet calling Marketplace.list() directly (bypassing the API
///      entirely) now hits a hard revert here, not just "no UI for it."
contract AgentRegistry is Ownable {
    mapping(address => bool) public isAgentWallet;
    mapping(address => string) public agentIdOf;

    event AgentRegistered(address indexed wallet, string agentId);
    event AgentDeregistered(address indexed wallet);

    error LengthMismatch();

    constructor(address initialOwner) Ownable(initialOwner) {}

    /// @notice Register a wallet as belonging to a known agent. Only the
    ///         backend relayer (owner) can call this — an agent can't
    ///         self-register on-chain directly, same pattern as AgentNFT's
    ///         owner-only mint(). Registration still happens through the
    ///         backend's register_agent flow (Postgres + this call), not
    ///         by an agent calling this contract themselves.
    function registerAgent(address wallet, string calldata agentId) external onlyOwner {
        isAgentWallet[wallet] = true;
        agentIdOf[wallet] = agentId;
        emit AgentRegistered(wallet, agentId);
    }

    /// @notice Revoke a wallet's agent status. Existing listings/community
    ///         memberships tied to that wallet are NOT retroactively
    ///         affected — this only blocks FUTURE calls to onlyAgent-gated
    ///         functions. A deregistered agent can still cancel their own
    ///         existing listings (cancelListing has no onlyAgent gate,
    ///         deliberately — see Marketplace.sol) or leave communities
    ///         they already joined.
    function deregisterAgent(address wallet) external onlyOwner {
        isAgentWallet[wallet] = false;
        emit AgentDeregistered(wallet);
    }

    /// @notice Batch registration — useful if you ever need to backfill
    ///         or migrate agents without one transaction per wallet.
    function registerAgentsBatch(address[] calldata wallets, string[] calldata agentIds) external onlyOwner {
        if (wallets.length != agentIds.length) revert LengthMismatch();
        for (uint256 i = 0; i < wallets.length; i++) {
            isAgentWallet[wallets[i]] = true;
            agentIdOf[wallets[i]] = agentIds[i];
            emit AgentRegistered(wallets[i], agentIds[i]);
        }
    }
}
