// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {IERC20} from "@openzeppelin/contracts/interfaces/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";

import {ASCBase} from "@gluwa/asc-contracts/contracts/readability/ASCBase.sol";
import {EvmV1Decoder} from "@gluwa/asc-contracts/contracts/common/EvmV1Decoder.sol";
import {INativeQueryVerifier} from "@gluwa/asc-contracts/contracts/write-ability/common/INativeQueryVerifier.sol";

/// @title ComputeCredVault
/// @notice Attestcoin Smart Contract (ASC) on Creditcoin that turns cryptographically verified
///         `JobSettled` revenue from an Ethereum-side job marketplace into a bounded, revolving
///         credit facility for independent GPU operators.
///
/// @dev State only changes after the Creditcoin Block Prover precompile proves a particular
///      Ethereum receipt. Removing Attestcoin means the vault cannot know whether a job was paid,
///      whether the payment was duplicated, or whether a worker fabricated a revenue claim.
///
/// Credit policy (deterministic, visible on-chain):
///   - eligibleRevenue   = min(revenueWindowed30d, operatorCap)
///   - facilityLimit     = 50% x eligibleRevenue            (advanceRateBps)
///   - concentration     = the share of the largest buyer above 40% of eligibleRevenue
///                         is not financed: book = eligible - max(0, largest - 40% x eligible)
///   - replay            = txHash (via proof query id) AND jobId are one-time
///   - draw        <= facilityLimit - outstandingDebt && vault liquidity
///   - auto-repay        = each verified settlement first pays accrued debt, then revenue
///
/// The receipt proves a trusted source-market contract settled the job; it does NOT prove that
/// physical GPU work was delivered. The source marketplace's admission/quality policy is
/// therefore explicit in the threat model.
contract ComputeCredVault is Ownable, ASCBase {
    using SafeERC20 for IERC20;

    /// keccak256("JobSettled(bytes32,address,address,uint128,uint64,bytes32)")
    bytes32 public constant JOB_SETTLED_EVENT_SIGNATURE =
        0x576d20c6973b5fc107e0f23c395df0170eaed2b08ca42f1192b69c63c0533e92;

    uint256 public constant BASIS_POINTS = 10_000;
    /// Up to 10 queries can share a single continuity proof (protocol documentation).
    uint256 public constant MAX_BATCH_SIZE = 10;
    /// Tolerance for wall-clock skew between the source chain and Creditcoin.
    uint64 public constant CLOCK_SKEW_TOLERANCE = 3600;

    enum VaultAction {
        RegisterSettlement // 0
    }

    struct RevenueEvent {
        uint256 amount;
        uint64 settledAt;
        address buyer;
        bytes32 jobId;
        address operator;
    }

    struct Facility {
        bool exists;
        uint256 outstandingDebt;
        uint256 lifetimeVerifiedRevenue;
        uint256 lifetimeDebtRepaidByRevenue;
        uint64 lastVerifiedAt;
        RevenueEvent[] events;
    }

    struct FacilityView {
        bool exists;
        uint256 verifiedRevenue;
        uint256 eligibleRevenue;
        uint256 facilityLimit;
        uint256 concentrationFactorBps;
        uint256 outstandingDebt;
        uint256 availableCapacity;
        uint256 vaultLiquidity;
        uint256 largestBuyerShareBps;
        uint64 lastVerifiedAt;
        uint256 lifetimeVerifiedRevenue;
        uint256 lifetimeDebtRepaidByRevenue;
        uint256 eventCount;
    }

    error InvalidAction(uint8 action);

    /// @notice Loan/liquidity token held by the vault (test USDC on CC3).
    IERC20 public immutable loanToken;
    /// @notice The single Ethereum-side marketplace contract whose `JobSettled` events are trusted.
    address public jobMarket;
    /// @notice Advance rate, in basis points (5000 == 50%).
    uint256 public advanceRateBps;
    /// @notice Max share of eligibleRevenue a single buyer may supply (4000 == 40%).
    uint256 public maxBuyerConcentrationBps;
    /// @notice Revenue cap applied before the advance rate (per operator).
    uint256 public operatorCap;
    /// @notice Trailing revenue window in seconds (30 days).
    uint64 public freshnessWindow;

    mapping(address => Facility) public facilities;
    mapping(address => RevenueEvent[]) public facilityEvents;
    /// @notice Job-level replay guard. Tx-level replay is guarded by ASCBase.processedQueries.
    mapping(bytes32 => bool) public usedJobIds;

    event FacilityOpened(address indexed operator, address loanToken);
    event SourceContractRegistered(address indexed jobMarket);
    event PolicyUpdated(bytes32 indexed reason);
    event SettlementVerified(
        address indexed operator,
        bytes32 indexed jobId,
        address indexed buyer,
        uint128 grossAmount,
        uint256 revenueApplied,
        bytes32 queryId
    );
    event DebtRepaidByRevenue(address indexed operator, uint256 amount, bytes32 jobId);
    event Drew(address indexed operator, uint256 amount);
    event Repaid(address indexed operator, uint256 amount);
    event LiquidityProvided(address indexed provider, uint256 amount);

    constructor(
        address _loanToken,
        uint256 _advanceRateBps,
        uint256 _maxBuyerConcentrationBps,
        uint256 _operatorCap,
        uint64 _freshnessWindow
    ) Ownable(msg.sender) {
        require(_loanToken != address(0), "ComputeCredVault: zero token");
        require(_advanceRateBps <= BASIS_POINTS, "ComputeCredVault: advance rate > 100%");
        require(_maxBuyerConcentrationBps <= BASIS_POINTS, "ComputeCredVault: concentration > 100%");
        loanToken = IERC20(_loanToken);
        advanceRateBps = _advanceRateBps;
        maxBuyerConcentrationBps = _maxBuyerConcentrationBps;
        operatorCap = _operatorCap;
        freshnessWindow = _freshnessWindow;
    }

    // ----------------------------------------------------------------------
    // Owner configuration
    // ----------------------------------------------------------------------

    /// @notice Registers the single trusted source-chain marketplace contract.
    function registerSourceContract(address _jobMarket) external onlyOwner {
        require(_jobMarket != address(0), "ComputeCredVault: zero source");
        jobMarket = _jobMarket;
        emit SourceContractRegistered(_jobMarket);
    }

    function setAdvanceRateBps(uint256 _advanceRateBps) external onlyOwner {
        require(_advanceRateBps <= BASIS_POINTS, "ComputeCredVault: advance rate > 100%");
        advanceRateBps = _advanceRateBps;
        emit PolicyUpdated("advance");
    }

    function setMaxBuyerConcentrationBps(uint256 _maxBuyerConcentrationBps) external onlyOwner {
        require(_maxBuyerConcentrationBps <= BASIS_POINTS, "ComputeCredVault: concentration > 100%");
        maxBuyerConcentrationBps = _maxBuyerConcentrationBps;
        emit PolicyUpdated("concentration");
    }

    function setOperatorCap(uint256 _operatorCap) external onlyOwner {
        operatorCap = _operatorCap;
        emit PolicyUpdated("cap");
    }

    function setFreshnessWindow(uint64 _freshnessWindow) external onlyOwner {
        freshnessWindow = _freshnessWindow;
        emit PolicyUpdated("freshness");
    }

    // ----------------------------------------------------------------------
    // Operator / liquidity provider actions
    // ----------------------------------------------------------------------

    /// @notice A GPU operator opens a facility. Ownership = the calling Creditcoin wallet.
    function openFacility() external {
        Facility storage f = facilities[msg.sender];
        require(!f.exists, "ComputeCredVault: facility exists");
        f.exists = true;
        emit FacilityOpened(msg.sender, address(loanToken));
    }

    /// @notice Liquidity provider deposits loan tokens that back draws.
    function provideLiquidity(uint256 amount) external {
        require(amount > 0, "ComputeCredVault: zero amount");
        loanToken.safeTransferFrom(msg.sender, address(this), amount);
        emit LiquidityProvided(msg.sender, amount);
    }

    /// @notice Operator draws against available capacity.
    function draw(uint256 amount) external {
        require(amount > 0, "ComputeCredVault: zero amount");
        Facility storage f = facilities[msg.sender];
        require(f.exists, "ComputeCredVault: facility not open");
        _pruneEvents(f);

        (, uint256 eligible, , , uint256 largest) = _aggregate(f);
        (uint256 limit, ) = _facilityLimit(eligible, largest);

        require(limit > f.outstandingDebt, "ComputeCredVault: over limit");
        require(amount <= limit - f.outstandingDebt, "ComputeCredVault: over limit");
        require(amount <= loanToken.balanceOf(address(this)), "ComputeCredVault: insufficient liquidity");

        f.outstandingDebt += amount;
        loanToken.safeTransfer(msg.sender, amount);
        emit Drew(msg.sender, amount);
    }

    /// @notice Manual repayment of accrued debt (auto-repay from verified revenue also applies).
    function repay(uint256 amount) external {
        require(amount > 0, "ComputeCredVault: zero amount");
        Facility storage f = facilities[msg.sender];
        require(f.exists, "ComputeCredVault: facility not open");
        require(amount <= f.outstandingDebt, "ComputeCredVault: over repay");
        loanToken.safeTransferFrom(msg.sender, address(this), amount);
        f.outstandingDebt -= amount;
        emit Repaid(msg.sender, amount);
    }

    // ----------------------------------------------------------------------
    // Attestcoin proof flow (readability ASC)
    // ----------------------------------------------------------------------

    /// @notice Verify a batch of up to 10 source transactions sharing one continuity proof, then
    ///         apply the credit policy for each settlement in order.
    function verifyAndRegisterBatch(
        uint64 chainKey,
        uint64[] calldata blockHeights,
        bytes[] calldata encodedTransactions,
        INativeQueryVerifier.MerkleProof[] calldata merkleProofs,
        INativeQueryVerifier.ContinuityProof calldata continuityProof
    ) external returns (bool) {
        uint256 n = encodedTransactions.length;
        require(n > 0 && n <= MAX_BATCH_SIZE, "ComputeCredVault: bad batch size");
        require(
            blockHeights.length == n &&
                merkleProofs.length == n,
            "ComputeCredVault: batch length mismatch"
        );

        bool verified = VERIFIER.verifyAndEmit(
            chainKey,
            blockHeights,
            encodedTransactions,
            merkleProofs,
            continuityProof
        );
        require(verified, "ComputeCredVault: batch verification failed");

        for (uint256 i = 0; i < n; ++i) {
            bytes32 queryId = _computeQueryId(chainKey, blockHeights[i], merkleProofs[i].root, merkleProofs[i].siblings);
            require(!processedQueries[queryId], "Query already processed");
            processedQueries[queryId] = true;
            _processAndEmitEvent(uint8(VaultAction.RegisterSettlement), queryId, encodedTransactions[i]);
        }
        return true;
    }

    /// @notice Convenience wrapper named exactly as in the design: verify one proof, then credit.
    function verifyAndRegister(
        uint64 chainKey,
        uint64 blockHeight,
        bytes calldata encodedTransaction,
        bytes32 merkleRoot,
        INativeQueryVerifier.MerkleProofEntry[] calldata siblings,
        bytes32 lowerEndpointDigest,
        bytes32[] calldata continuityRoots
    ) external returns (bool) {
        return this.execute(
            uint8(VaultAction.RegisterSettlement),
            chainKey,
            blockHeight,
            encodedTransaction,
            merkleRoot,
            siblings,
            lowerEndpointDigest,
            continuityRoots
        );
    }

    /// @dev ASCBase hook: strict receipt validation + deterministic credit policy. Reverts on any
    ///      invalid, malformed, wrong-contract, wrong-event, failed, stale, or replayed input —
    ///      making Attestcoin a state-transition gate, not a dashboard API call.
    function _processAndEmitEvent(
        uint8 action,
        bytes32 queryId,
        bytes memory encodedTransaction
    ) internal override {
        if (action != uint8(VaultAction.RegisterSettlement)) revert InvalidAction(action);

        RevenueEvent memory ev = _extractSettlement(encodedTransaction);
        require(msg.sender == ev.operator, "ComputeCredVault: operator mismatch");

        Facility storage f = facilities[ev.operator];
        require(f.exists, "ComputeCredVault: facility not open");

        require(!usedJobIds[ev.jobId], "ComputeCredVault: job already used");
        usedJobIds[ev.jobId] = true;

        // A later verified settlement first pays accrued debt, then contributes to revenue.
        uint256 debtPayment = ev.amount <= f.outstandingDebt ? ev.amount : f.outstandingDebt;
        if (debtPayment > 0) {
            f.outstandingDebt -= debtPayment;
            f.lifetimeDebtRepaidByRevenue += debtPayment;
            emit DebtRepaidByRevenue(ev.operator, debtPayment, ev.jobId);
        }
        uint256 revenueApplied = ev.amount - debtPayment;
        if (revenueApplied > 0) {
            f.lifetimeVerifiedRevenue += revenueApplied;
            f.events.push(
                RevenueEvent({
                    amount: revenueApplied,
                    settledAt: ev.settledAt,
                    buyer: ev.buyer,
                    jobId: ev.jobId,
                    operator: ev.operator
                })
            );
        }
        f.lastVerifiedAt = ev.settledAt;

        _pruneEvents(f);
        emit SettlementVerified(ev.operator, ev.jobId, ev.buyer, uint128(ev.amount), revenueApplied, queryId);
    }

    /// @dev Decodes and strictly validates a settlement log from a proven source receipt. Every
    ///      security property the strategy demands is checked here:
    ///      success status, correct topic, registered emitter, arity, nonzero amount, freshness,
    ///      and correct claimant.
    function _extractSettlement(bytes memory encodedTransaction) internal view returns (RevenueEvent memory ev) {
        uint8 txType = EvmV1Decoder.getTransactionType(encodedTransaction);
        require(EvmV1Decoder.isValidTransactionType(txType), "ComputeCredVault: unsupported tx type");

        EvmV1Decoder.ReceiptFields memory receipt = EvmV1Decoder.decodeReceiptFields(encodedTransaction);
        require(receipt.receiptStatus == 1, "ComputeCredVault: source receipt failed");

        EvmV1Decoder.LogEntry[] memory logs =
            EvmV1Decoder.getLogsByEventSignature(receipt, JOB_SETTLED_EVENT_SIGNATURE);
        require(logs.length == 1, "ComputeCredVault: expected one JobSettled log");

        EvmV1Decoder.LogEntry memory log = logs[0];

        require(jobMarket != address(0), "ComputeCredVault: source contract not registered");
        require(log.address_ == jobMarket, "ComputeCredVault: wrong source contract");

        require(log.topics.length == 4, "ComputeCredVault: invalid JobSettled topics");
        // topics[0] is guaranteed to be JOB_SETTLED_EVENT_SIGNATURE: the decoder above filtered on it.
        require(log.data.length == 96, "ComputeCredVault: invalid JobSettled data");

        ev.jobId = log.topics[1];
        ev.operator = address(uint160(uint256(log.topics[2])));
        ev.buyer = address(uint160(uint256(log.topics[3])));

        (uint128 grossAmount, uint64 completedAt, ) =
            abi.decode(log.data, (uint128, uint64, bytes32));
        require(grossAmount > 0, "ComputeCredVault: zero gross amount");

        uint64 nowTs = uint64(block.timestamp);
        require(completedAt <= nowTs + CLOCK_SKEW_TOLERANCE, "ComputeCredVault: settlement timestamp in future");
        require(completedAt + freshnessWindow >= nowTs, "ComputeCredVault: settlement too old");

        ev.amount = uint256(grossAmount);
        ev.settledAt = completedAt;
    }

    // ----------------------------------------------------------------------
    // View helpers
    // ----------------------------------------------------------------------

    function getPolicy() external view returns (uint256, uint256, uint256, uint64) {
        return (advanceRateBps, maxBuyerConcentrationBps, operatorCap, freshnessWindow);
    }

    function getFacilityView(address operator) external view returns (FacilityView memory view_) {
        Facility storage f = facilities[operator];
        view_.exists = f.exists;
        if (!f.exists) return view_;

        (uint256 total, uint256 eligible, , , uint256 largest) = _aggregate(f);
        (uint256 limit, uint256 factorBps) = _facilityLimit(eligible, largest);
        view_.verifiedRevenue = total;
        view_.eligibleRevenue = eligible;
        view_.facilityLimit = limit;
        view_.concentrationFactorBps = factorBps;
        view_.outstandingDebt = f.outstandingDebt;
        view_.availableCapacity = limit > f.outstandingDebt ? limit - f.outstandingDebt : 0;
        view_.vaultLiquidity = loanToken.balanceOf(address(this));
        view_.largestBuyerShareBps = total == 0 ? 0 : (largest * BASIS_POINTS) / total;
        view_.lastVerifiedAt = f.lastVerifiedAt;
        view_.lifetimeVerifiedRevenue = f.lifetimeVerifiedRevenue;
        view_.lifetimeDebtRepaidByRevenue = f.lifetimeDebtRepaidByRevenue;
        view_.eventCount = _windowedEventCount(f);
    }

    /// @notice Per-buyer revenue totals within the freshness window (for the dashboard).
    function getBuyerTotals(address operator) external view returns (address[] memory, uint256[] memory) {
        Facility storage f = facilities[operator];
        if (!f.exists || f.events.length == 0) {
            return (new address[](0), new uint256[](0));
        }
        (, , address[] memory buyers, uint256[] memory totals, ) = _aggregate(f);
        return (buyers, totals);
    }

    function getEventCount(address operator) external view returns (uint256) {
        return facilities[operator].events.length;
    }

    function getEvent(address operator, uint256 index) external view returns (RevenueEvent memory) {
        return facilities[operator].events[index];
    }

    // ----------------------------------------------------------------------
    // Internal
    // ----------------------------------------------------------------------

    function _windowedEventCount(Facility storage f) internal view returns (uint256 count) {
        uint64 nowTs = uint64(block.timestamp);
        uint256 n = f.events.length;
        for (uint256 i = 0; i < n; ++i) {
            if (_inWindow(f.events[i].settledAt, nowTs)) ++count;
        }
    }

    function _inWindow(uint64 settledAt, uint64 nowTs) internal view returns (bool) {
        uint64 minTs = nowTs >= freshnessWindow ? nowTs - freshnessWindow : 0;
        return settledAt >= minTs && settledAt <= nowTs + CLOCK_SKEW_TOLERANCE;
    }

    /// @dev Compacts storage, dropping events outside the freshness window.
    function _pruneEvents(Facility storage f) internal {
        uint64 nowTs = uint64(block.timestamp);
        uint256 n = f.events.length;
        uint256 writeIdx = 0;
        for (uint256 i = 0; i < n; ++i) {
            if (_inWindow(f.events[i].settledAt, nowTs)) {
                if (writeIdx != i) f.events[writeIdx] = f.events[i];
                ++writeIdx;
            }
        }
        while (f.events.length > writeIdx) f.events.pop();
    }

    /// @dev Aggregates windowed revenue. Returns the raw window total, the capped eligible
    ///      revenue, per-buyer totals, and the largest single-buyer amount.
    function _aggregate(Facility storage f)
        internal
        view
        returns (uint256 total, uint256 eligible, address[] memory buyers, uint256[] memory totals, uint256 largest)
    {
        uint64 nowTs = uint64(block.timestamp);
        uint256 n = f.events.length;
        address[] memory b = new address[](n);
        uint256[] memory t = new uint256[](n);
        uint256 k = 0;
        for (uint256 i = 0; i < n; ++i) {
            RevenueEvent storage e = f.events[i];
            if (!_inWindow(e.settledAt, nowTs)) continue;
            total += e.amount;
            bool found = false;
            for (uint256 j = 0; j < k; ++j) {
                if (b[j] == e.buyer) {
                    t[j] += e.amount;
                    found = true;
                    break;
                }
            }
            if (!found) {
                b[k] = e.buyer;
                t[k] = e.amount;
                ++k;
            }
        }
        buyers = new address[](k);
        totals = new uint256[](k);
        for (uint256 j = 0; j < k; ++j) {
            buyers[j] = b[j];
            totals[j] = t[j];
            if (t[j] > largest) largest = t[j];
        }
        eligible = total > operatorCap ? operatorCap : total;
    }

    /// @dev Computes the facility limit. Concentration is priced as "the portion of the largest
    ///      buyer above 40% of the eligible base is not financed":
    ///        book   = eligible - max(0, largestBuyer - 0.40 * eligible)
    ///        limit  = advanceRate * book
    ///      This keeps the strategy's base formula (limit = 0.50 * eligible) exactly when revenue
    ///      is diversified (largest buyer <= 40%), while a single-client operator is still
    ///      bookable but only finances the diversified-equivalent portion of their base.
    function _facilityLimit(
        uint256 eligible,
        uint256 largest
    ) internal view returns (uint256 limit, uint256 factorBps) {
        if (eligible == 0) {
            return (0, BASIS_POINTS);
        }
        uint256 allowedShare = (eligible * maxBuyerConcentrationBps) / BASIS_POINTS;
        uint256 excess = largest > allowedShare ? largest - allowedShare : 0;
        uint256 book = eligible > excess ? eligible - excess : 0;
        limit = (book * advanceRateBps) / BASIS_POINTS;
        factorBps = (book * BASIS_POINTS) / eligible;
        return (limit, factorBps);
    }
}