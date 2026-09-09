// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

/// @title TxEncoder
/// @notice Builds ABI-encoded transactions that match the EvmV1Decoder layout
///         (`abi.encode(uint8 txType, bytes[] chunks)`), so tests can feed synthetic
///         (mal)formed source receipts into the vault's decode/validation path without
///         needing the Creditcoin Block Prover.
///
/// Layout for type 0 (legacy):
///   chunks[0] = abi.encode(nonce, gasLimit, from, toIsNull, to, value, data)
///   chunks[1] = abi.encode(gasPrice, v, r, s)
///   chunks[2] = abi.encode(receiptStatus, gasUsed, Log[], logsBloom)
contract TxEncoder {
    struct Log {
        address address_;
        bytes32[] topics;
        bytes data;
    }

    function encodeSettlement(
        uint8 receiptStatus,
        address logAddress,
        bytes32 jobId,
        address operator,
        address buyer,
        uint128 grossAmount,
        uint64 completedAt,
        bytes32 workloadCommitment
    ) public pure returns (bytes memory) {
        bytes32[4] memory topics;
        topics[0] = 0x576d20c6973b5fc107e0f23c395df0170eaed2b08ca42f1192b69c63c0533e92; // JobSettled sig
        topics[1] = jobId;
        topics[2] = bytes32(uint256(uint160(operator)));
        topics[3] = bytes32(uint256(uint160(buyer)));

        bytes memory data = abi.encode(grossAmount, completedAt, workloadCommitment);

        return _encodeTx(receiptStatus, logAddress, topics, data);
    }

    /// @notice Builds a JobSettled log with an arbitrary topic0 (wrong event) and free-form data.
    function encodeSettlementRaw(
        uint8 receiptStatus,
        address logAddress,
        bytes32 topic0,
        bytes32 topic1,
        bytes32 topic2,
        bytes32 topic3,
        bytes memory data
    ) external pure returns (bytes memory) {
        bytes32[4] memory topics = [topic0, topic1, topic2, topic3];
        return _encodeTx(receiptStatus, logAddress, topics, data);
    }

    function encodeFailedReceipt(
        address logAddress,
        bytes32 jobId,
        address operator,
        address buyer,
        uint128 grossAmount,
        uint64 completedAt
    ) external pure returns (bytes memory) {
        return encodeSettlement(0, logAddress, jobId, operator, buyer, grossAmount, completedAt, bytes32(0));
    }

    /// @notice Builds any transaction containing a single log (free topics + free data), letting
    ///         tests exercise wrong-topic, wrong-arity, and wrong-data-length paths.
    function encodeLog(address logAddress, bytes32[] calldata topics, bytes calldata data)
        external
        pure
        returns (bytes memory)
    {
        bytes memory chunks0 = abi.encode(uint64(0), uint64(21000), address(0xA11CE), false, logAddress, uint256(0), hex"");
        bytes memory chunks1 = abi.encode(uint128(1 gwei), uint256(0), bytes32(0), bytes32(0));
        bytes memory chunks2 = abi.encode(uint8(1), uint64(21000), _logsWith(logAddress, topics, data), hex"");

        bytes[] memory chunks = new bytes[](3);
        chunks[0] = chunks0;
        chunks[1] = chunks1;
        chunks[2] = chunks2;

        return abi.encode(uint8(0), chunks);
    }

    function _logsWith(address logAddress, bytes32[] memory topics, bytes memory data)
        internal
        pure
        returns (Log[] memory logs)
    {
        logs = new Log[](1);
        logs[0].address_ = logAddress;
        logs[0].topics = topics;
        logs[0].data = data;
    }

    function _encodeTx(
        uint8 receiptStatus,
        address logAddress,
        bytes32[4] memory topics,
        bytes memory data
    ) internal pure returns (bytes memory) {
        bytes memory chunks0 = abi.encode(uint64(0), uint64(21000), address(0xA11CE), false, logAddress, uint256(0), hex"");
        bytes memory chunks1 = abi.encode(uint128(1 gwei), uint256(0), bytes32(0), bytes32(0));
        bytes memory chunks2 = abi.encode(receiptStatus, uint64(21000), _singleLog(logAddress, topics, data), hex"");

        bytes[] memory chunks = new bytes[](3);
        chunks[0] = chunks0;
        chunks[1] = chunks1;
        chunks[2] = chunks2;

        return abi.encode(uint8(0), chunks);
    }

    function _singleLog(address logAddress, bytes32[4] memory topics, bytes memory data)
        internal
        pure
        returns (Log[] memory logs)
    {
        logs = new Log[](1);
        logs[0].address_ = logAddress;
        logs[0].topics = new bytes32[](4);
        logs[0].topics[0] = topics[0];
        logs[0].topics[1] = topics[1];
        logs[0].topics[2] = topics[2];
        logs[0].topics[3] = topics[3];
        logs[0].data = data;
    }
}