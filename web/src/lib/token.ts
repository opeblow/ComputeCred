import { ethers } from 'ethers';

const ERC20_ABI = [
  'function balanceOf(address owner) view returns (uint256)',
  'function allowance(address owner, address spender) view returns (uint256)',
  'function approve(address spender, uint256 amount) returns (bool)',
] as const;

/** Loan token (tUSDC) helpers used by facility actions. */
export class LoanToken {
  readonly contract: ethers.Contract;

  constructor(signerOrProvider: ethers.Signer | ethers.Provider, address: string) {
    this.contract = new ethers.Contract(address, ERC20_ABI, signerOrProvider);
  }

  async allowance(owner: string, spender: string): Promise<bigint> {
    return (await (this.contract.allowance as (owner: string, spender: string) => Promise<bigint>)(owner, spender)) as bigint;
  }

  async balanceOf(owner: string): Promise<bigint> {
    return (await (this.contract.balanceOf as (owner: string) => Promise<bigint>)(owner)) as bigint;
  }

  async approve(spender: string, amount: bigint): Promise<ethers.ContractTransactionResponse> {
    return (await (this.contract.approve as (spender: string, amount: bigint) => Promise<ethers.ContractTransactionResponse>)(spender, amount)) as ethers.ContractTransactionResponse;
  }

  /** Returns the approval tx when one is required, else null. */
  async ensureApproval(owner: string, spender: string, amount: bigint): Promise<ethers.ContractTransactionResponse | null> {
    const current = await this.allowance(owner, spender);
    if (current >= amount) return null;
    return this.approve(spender, amount);
  }
}