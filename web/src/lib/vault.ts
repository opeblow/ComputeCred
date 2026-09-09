import { ethers } from 'ethers';
import vaultArtifact from '../../../contracts/artifacts/contracts/ComputeCredVault.sol/ComputeCredVault.json';

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
  lifetimeRepaid: bigint;
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

export interface FacilitySnapshot {
  view: FacilityView | null;
  policy: Policy | null;
  buyers: BuyerTotal[];
}

export type VaultCallable = {
  getPolicy(): Promise<[bigint, bigint, bigint, bigint]>;
  getFacilityView(operator: string): Promise<FacilityView>;
  getBuyerTotals(operator: string): Promise<[string[], bigint[]]>;
  queryFilter(eventName: string, fromBlock: number, toBlock: number): Promise<ethers.EventLog[]>;
  pauseBorrowing(): Promise<unknown>;
  unpauseBorrowing(): Promise<unknown>;
  openFacility(): Promise<unknown>;
  provideLiquidity(amount: bigint): Promise<unknown>;
  draw(amount: bigint): Promise<unknown>;
  repay(amount: bigint): Promise<unknown>;
  expectedSourceChainKey(): Promise<bigint>;
  loanToken(): Promise<string>;
  settlementAsset(): Promise<string>;
  paused(): Promise<boolean>;
};

export const asVault = (c: ethers.Contract): VaultCallable => c as unknown as VaultCallable;

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

/** Recent `SettlementVerified` logs (ascending). */
export async function getRecentSettlements(
  vault: VaultCallable,
  fromBlock: number,
  toBlock: number,
  limit = 20
): Promise<ethers.EventLog[]> {
  const events = await vault.queryFilter('SettlementVerified', fromBlock, toBlock);
  return events.slice(-limit);
}

export async function loadSnapshot(vault: VaultCallable, operator: string): Promise<FacilitySnapshot> {
  const [policy, view, buyers] = await Promise.all([
    getPolicy(vault),
    vault.getFacilityView(operator),
    getBuyerTotals(vault, operator),
  ]);
  return { view, policy, buyers };
}