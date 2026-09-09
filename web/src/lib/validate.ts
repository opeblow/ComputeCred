import { ethers } from 'ethers';

export function isAddress(value: string): boolean {
  try {
    return ethers.isAddress(value);
  } catch {
    return false;
  }
}

export function parseAmount(value: string, decimals = 6): bigint | null {
  const clean = value.trim();
  if (!clean) return null;
  try {
    if (!/^\d*\.?\d*$/.test(clean)) return null;
    const parsed = ethers.parseUnits(clean || '0', decimals);
    if (parsed < 0n) return null;
    return parsed;
  } catch {
    return null;
  }
}

export function amountError(value: string, opts: { required?: boolean; max?: bigint } = {}): string | null {
  const trimmed = value.trim();
  if (!trimmed) return opts.required ? 'Amount is required.' : null;
  const parsed = parseAmount(trimmed);
  if (parsed === null) return 'Enter a valid amount (e.g. 12.5).';
  if (parsed <= 0n) return 'Amount must be positive.';
  if (opts.max !== undefined && parsed > opts.max) return `Amount exceeds your available capacity (${ethers.formatUnits(opts.max, 6)}).`;
  return null;
}

/** Client-side sanity: is the currently connected wallet on the expected chain key? */
export async function assertChain(signer: ethers.JsonRpcSigner, expectedChainKey: bigint): Promise<boolean> {
  if (expectedChainKey !== 0n && expectedChainKey !== 1n) return true; // don't guess CC3's chain id client-side
  const network = await signer.provider?.getNetwork();
  return network?.chainId === 2323n || network?.chainId === 1230n; // CC3 testnet/prod ranges
}