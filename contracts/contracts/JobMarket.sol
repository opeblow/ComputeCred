// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

/// @title JobMarket
/// @notice Minimal GPU-job marketplace deployed on Ethereum Sepolia. A buyer pre-pays (escrows)
///         native token when creating a job, then settles it once the operator delivers. The
///         settlement emits the `JobSettled` event, which is the revenue evidence primitive that
///         ComputeCred proves on Creditcoin.
///
/// @dev ComputeCred's threat model relies on this contract emitting `JobSettled` ONLY after a
///      settlement is complete. A self-reported `submitJob()` call is deliberately absent: a job
///      the operator merely claimed is NOT revenue. The admission/quality policy of the source
///      marketplace is therefore explicit in the threat model.
contract JobMarket {
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

    constructor() {}

    /// @notice Notify the marketplace about a job offer. Non-payable: escrow happens at settlement,
    ///         so no funds are touchable until the buyer actually pays.
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

    /// @notice Buyer pays `msg.value` and settles a completed job in one transaction. This is the
    ///         ONLY path to `JobSettled`, and it requires the caller to be the buyer with a created
    ///         job. The gross amount is frozen on settlement; the operator later withdraws escrow.
    function payAndSettle(bytes32 jobId) external payable returns (bool) {
        require(msg.value > 0, "JobMarket: zero payment");
        require(jobId != bytes32(0), "JobMarket: zero job id");

        Job storage job = jobs[jobId];
        require(job.created, "JobMarket: unknown job");
        require(!job.settled, "JobMarket: already settled");
        require(msg.sender == job.buyer, "JobMarket: only buyer can settle");

        job.price = msg.value;
        job.settled = true;

        emit JobSettled(
            job.id,
            job.operator,
            job.buyer,
            uint128(msg.value),
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

        (bool ok, ) = msg.sender.call{value: amount}("");
        require(ok, "JobMarket: transfer failed");

        emit EscrowWithdrawn(jobId, msg.sender, amount);
    }

    receive() external payable {}

    fallback() external payable {}
}