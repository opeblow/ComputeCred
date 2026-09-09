import '@nomicfoundation/hardhat-toolbox';
import { HardhatUserConfig } from 'hardhat/config';
import * as dotenv from 'dotenv';

dotenv.config({ path: '../.env' });

const sourceChainRpcUrl = process.env.SOURCE_CHAIN_RPC_URL || 'http://127.0.0.1:8545';
const creditcoinRpcUrl = process.env.CREDITCOIN_RPC_URL || 'http://127.0.0.1:8545';
const privateKey = process.env.CREDITCOIN_WALLET_PRIVATE_KEY || '';

const config: HardhatUserConfig = {
  solidity: {
    version: '0.8.30',
    settings: {
      optimizer: { enabled: true, runs: 200 },
      viaIR: true,
      evmVersion: 'shanghai',
    },
  },
  networks: {
    hardhat: {},
    sepolia: {
      url: sourceChainRpcUrl,
      accounts: privateKey ? [privateKey] : [],
    },
    creditcoin: {
      url: creditcoinRpcUrl,
      accounts: privateKey ? [privateKey] : [],
    },
  },
  paths: {
    sources: './contracts',
    tests: './test',
    artifacts: './artifacts',
    cache: './cache',
  },
  mocha: {
    timeout: 240000,
  },
};

export default config;