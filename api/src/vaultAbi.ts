export const vaultAbi = [
  'function getFacilityView(address operator) view returns (tuple(bool exists, uint256 verifiedRevenue, uint256 eligibleRevenue, uint256 facilityLimit, uint256 concentrationFactorBps, uint256 outstandingDebt, uint256 availableCapacity, uint256 vaultLiquidity, uint256 largestBuyerShareBps, uint64 lastVerifiedAt, uint256 lifetimeVerifiedRevenue, uint256 lifetimeRepaid, uint256 eventCount))',
  'function getPolicy() view returns (uint256 advanceRateBps, uint256 maxBuyerConcentrationBps, uint256 operatorCap, uint64 freshnessWindow)',
  'function getEventCount(address operator) view returns (uint256)',
  'function usedJobIds(bytes32 jobId) view returns (bool)',
  'function jobMarket() view returns (address)',
  'function settlementAsset() view returns (address)',
  'function loanToken() view returns (address)',
  'function expectedSourceChainKey() view returns (uint64)',
] as const;