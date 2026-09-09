import type { InterfaceAbi } from 'ethers';
import vaultArtifact from '../../contracts/artifacts/contracts/ComputeCredVault.sol/ComputeCredVault.json' assert { type: 'json' };
import marketArtifact from '../../contracts/artifacts/contracts/JobMarket.sol/JobMarket.json' assert { type: 'json' };

export const vaultAbi: InterfaceAbi = (vaultArtifact as { abi: InterfaceAbi }).abi;
export const marketAbi: InterfaceAbi = (marketArtifact as { abi: InterfaceAbi }).abi;