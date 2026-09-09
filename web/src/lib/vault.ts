import { ethers } from 'ethers';
import vaultArtifact from '../../../contracts/artifacts/contracts/ComputeCredVault.sol/ComputeCredVault.json';

// Deterministic type for the FacilityView struct returned by getFacilityView().
export interface FacilityView {
  exists: boolean;
  verifiedRevenue: bigint;
  eligibleRevenue: bigint;
  facilityLimit: bigint;
  concentrationFactorBps: bigint;
  outstandingDebt: bigint;
  availableCapacity: bigint;
  vaultLiquidity: bigint;
  largestBuyerShareBps: bigint;
  lastVerifiedAt: bigint;
  lifetimeVerifiedRevenue: bigint;
  lifetimeDebtRepaidByRevenue: bigint;
  eventCount: bigint;
}

export interface Policy {
  advanceRateBps: bigint;
  maxBuyerConcentrationBps: bigint;
  operatorCap: bigint;
  freshnessWindow: bigint;
}

export interface BuyerTotal {
  buyer: string;
  amount: bigint;
}

export type VaultCallable = {
  getPolicy(): Promise<[bigint, bigint, bigint, bigint]>;
  getFacilityView(operator: string): Promise<FacilityView>;
  getBuyerTotals(operator: string): Promise<[string[], bigint[]]>;
  queryFilter(eventName: string, fromBlock: number, toBlock: number): Promise<ethers.EventLog[]>;
  draw(amount: bigint): Promise<unknown>;
  repay(amount: bigint): Promise<unknown>;
};

export const asVault = (c: ethers.Contract): VaultCallable => c as unknown as VaultCallable;

export const decimal = (v: bigint): string => ethers.formatUnits(v, 6);
export const bps = (v: bigint): string => `${(Number(v) / 100).toFixed(2)}%`;
export const short = (a: string): string => `${a.slice(0, 6)}..${a.slice(-4)}`;

const abi = (vaultArtifact as { abi: unknown }).abi as ethers.InterfaceAbi;

export function createVault(provider: ethers.Provider, address: string): VaultCallable {
  return asVault(new ethers.Contract(address, abi, provider));
}

export function createSignerVault(signer: ethers.Signer, address: string): VaultCallable {
  return asVault(new ethers.Contract(address, abi, signer));
}

export async function getPolicy(vault: VaultCallable): Promise<Policy> {
  const [advanceRateBps, maxBuyerConcentrationBps, operatorCap, freshnessWindow] = await vault.getPolicy();
  return { advanceRateBps, maxBuyerConcentrationBps, operatorCap, freshnessWindow };
}

export async function getBuyerTotals(vault: VaultCallable, operator: string): Promise<BuyerTotal[]> {
  const [buyers, amounts] = await vault.getBuyerTotals(operator);
  return buyers.map((buyer, i) => ({ buyer, amount: amounts[i] ?? 0n }));
}

// Last `limit` SettlementVerified events in ascending block order.
export async function getRecentSettlements(
  vault: VaultCallable,
  fromBlock: number,
  toBlock: number,
  limit = 20
): Promise<ethers.EventLog[]> {
  const events = await vault.queryFilter('SettlementVerified', fromBlock, toBlock);
  return events.slice(-limit);
}