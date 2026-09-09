// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {IERC20} from "@openzeppelin/contracts/interfaces/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";

/// @title JobMarket
/// @notice GPU-job marketplace deployed on an Ethereum-side chain (Sepolia). A buyer pre-pays
///         escrow in a 6-decimal settlement asset when creating a job, then settles it once the
///         operator delivers. The settlement emits the `JobSettled` event, which is the revenue
///         evidence primitive that ComputeCred proves on Creditcoin.
///
/// @dev Settlement is denominated in an explicit ERC-20 (the same 6-decimal unit the vault
///      lends in), so gross amounts never mix native-token (18-dec) value into 6-dec loan
///      accounting. ComputeCred's threat model relies on this contract emitting `JobSettled`
///      ONLY after a settlement is complete: a self-reported `submitJob()` call is deliberately
///      absent. Work quality/admission policy of the marketplace is explicit in the threat model.
contract JobMarket {
    using SafeERC20 for IERC20;

    struct Job {
        bytes32 id;
        address buyer;
        address operator;
        bytes32 workloadCommitment;
        uint256 price;
        bool created;
        bool settled;
        bool withdrawn;
    }

    /// keccak256("JobCreated(bytes32,address,address,uint256,bytes32)")
    bytes32 internal constant JOB_CREATED_EVENT_SIGNATURE =
        0xc4c36a9dc6e61d6ef73b998266413543952d4622a7bb5eae9399109c84bc4eae;

    /// keccak256("JobSettled(bytes32,address,address,uint128,uint64,bytes32)")
    bytes32 internal constant JOB_SETTLED_EVENT_SIGNATURE =
        0x576d20c6973b5fc107e0f23c395df0170eaed2b08ca42f1192b69c63c0533e92;

    /// @notice The asset jobs are escrowed and settled in. Gross revenue is expressed in its
    ///         (6-decimal) units; the vault enforces same-decimals against the loan token.
    IERC20 public immutable settlementToken;

    uint256 public nextJobNonce;
    mapping(bytes32 => Job) public jobs;

    event JobCreated(
        bytes32 indexed jobId,
        address indexed buyer,
        address indexed operator,
        uint256 price,
        bytes32 workloadCommitment
    );
    event JobSettled(
        bytes32 indexed jobId,
        address indexed operator,
        address indexed buyer,
        uint128 grossAmount,
        uint64 completedAt,
        bytes32 workloadCommitment
    );
    event EscrowWithdrawn(bytes32 indexed jobId, address indexed operator, uint256 amount);

    constructor(address _settlementToken) {
        require(_settlementToken != address(0), "JobMarket: zero settlement token");
        settlementToken = IERC20(_settlementToken);
    }

    function settlementAsset() external view returns (address) {
        return address(settlementToken);
    }

    /// @notice Buyer creates a job offer for `operator`. No funds move yet; escrow happens at
    ///         commitment time under `payAndSettle`.
    function createJob(
        address operator,
        bytes32 workloadCommitment
    ) external returns (bytes32 jobId) {
        require(operator != address(0), "JobMarket: zero operator");
        require(operator != msg.sender, "JobMarket: operator must differ from buyer");

        jobId = keccak256(abi.encodePacked(msg.sender, operator, block.number, nextJobNonce++));
        jobs[jobId] = Job({
            id: jobId,
            buyer: msg.sender,
            operator: operator,
            workloadCommitment: workloadCommitment,
            price: 0,
            created: true,
            settled: false,
            withdrawn: false
        });

        emit JobCreated(jobId, msg.sender, operator, 0, workloadCommitment);
    }

    /// @notice Buyer locks `amount` of settlement tokens into escrow and settles a completed job
    ///         in one transaction. This is the ONLY path to `JobSettled`. The gross amount is
    ///         frozen on settlement; the operator withdraws escrow later (proceeds are payable to
    ///         the operator wallet, and are NOT automatically remitted to the vault — repayment of
    ///         a facility draw is a separate, explicit action).
    function payAndSettle(bytes32 jobId, uint256 amount) external returns (bool) {
        require(amount > 0, "JobMarket: zero payment");
        require(jobId != bytes32(0), "JobMarket: zero job id");

        Job storage job = jobs[jobId];
        require(job.created, "JobMarket: unknown job");
        require(!job.settled, "JobMarket: already settled");
        require(msg.sender == job.buyer, "JobMarket: only buyer can settle");

        job.price = amount;
        job.settled = true;

        settlementToken.safeTransferFrom(msg.sender, address(this), amount);

        emit JobSettled(
            job.id,
            job.operator,
            job.buyer,
            uint128(amount),
            uint64(block.timestamp),
            job.workloadCommitment
        );

        return true;
    }

    /// @notice Operator collects the escrowed gross amount after settlement.
    function withdrawEscrow(bytes32 jobId) external returns (uint256 amount) {
        Job storage job = jobs[jobId];
        require(job.created, "JobMarket: unknown job");
        require(job.settled, "JobMarket: not settled");
        require(msg.sender == job.operator, "JobMarket: only operator can withdraw");
        require(!job.withdrawn, "JobMarket: already withdrawn");

        job.withdrawn = true;
        amount = job.price;

        settlementToken.safeTransfer(msg.sender, amount);

        emit EscrowWithdrawn(jobId, msg.sender, amount);
    }
}