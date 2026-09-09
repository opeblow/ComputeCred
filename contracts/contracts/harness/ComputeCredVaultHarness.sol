// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {ComputeCredVault} from "../ComputeCredVault.sol";
import {EvmV1Decoder} from "@gluwa/asc-contracts/contracts/common/EvmV1Decoder.sol";

/// @dev Test harness exposing internals of ComputeCredVault so the credit policy can be exercised
///      on a plain EVM without the Creditcoin Block Prover precompile. The precompile itself is
///      covered by the "altered proof" test against the production bytecode.
contract ComputeCredVaultHarness is ComputeCredVault {
    constructor(
        address _loanToken,
        uint256 _advanceRateBps,
        uint256 _maxBuyerConcentrationBps,
        uint256 _operatorCap,
        uint64 _freshnessWindow
    )
        ComputeCredVault(_loanToken, _advanceRateBps, _maxBuyerConcentrationBps, _operatorCap, _freshnessWindow)
    {}

    function exposeProcessEvent(uint8 action, bytes32 queryId, bytes memory encodedTransaction) external {
        _processAndEmitEvent(action, queryId, encodedTransaction);
    }

    function exposeExtractSettlement(bytes memory encodedTransaction) external view returns (RevenueEvent memory) {
        return _extractSettlement(encodedTransaction);
    }

    function exposePrune() external {
        _pruneEvents(facilities[msg.sender]);
    }

    function exposeAggregate()
        external
        view
        returns (uint256 total, uint256 eligible, address[] memory buyers, uint256[] memory totals, uint256 largest)
    {
        return _aggregate(facilities[msg.sender]);
    }

    function exposeWindowedCount() external view returns (uint256) {
        return _windowedEventCount(facilities[msg.sender]);
    }

    function exposeIsInWindow(uint64 settledAt, uint64 nowTs) external view returns (bool) {
        return _inWindow(settledAt, nowTs);
    }
}