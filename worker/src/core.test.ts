import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Contract, ethers } from 'ethers';
import { vaultAbi, marketAbi } from './abis';
import { JOB_SETTLED_TOPIC0, buildVerifyData, isTerminalRevert } from './proof';

const algo = (name: string, fn: () => void | Promise<void>) => test(name, fn);

algo('JobSettled topic0 matches the vault+sdk event signature', async () => {
  const market = new Contract(ethers.ZeroAddress, marketAbi);
  assert.equal(market.interface.getEvent('JobSettled')!.topicHash.toLowerCase(), JOB_SETTLED_TOPIC0.toLowerCase());

  // The vault itself does not declare JobSettled (it is decoded from the proven receipt), but its
  // public constant pins the exact signature bytes the worker + on-chain decoder both use.
  const vault = new Contract(ethers.ZeroAddress, vaultAbi);
  assert.ok(vault.interface.getFunction('verifyAndRegister'));
  assert.ok(vault.interface.getFunction('execute(uint8,uint64,uint64,bytes,bytes32,tuple(bytes32,bool)[],bytes32,bytes32[])'));
});

algo('market ABI decodes a JobSettled log to the vault tuple layout', async () => {
  const market = new Contract(ethers.ZeroAddress, marketAbi);
  const operator = `0x${'aa'.repeat(20)}`;
  const buyer = `0x${'bb'.repeat(20)}`;
  const jobId = ethers.id('demo-job');

  const log = {
    address: String(market.target),
    topics: [
      JOB_SETTLED_TOPIC0,
      jobId,
      ethers.zeroPadValue(operator, 32),
      ethers.zeroPadValue(buyer, 32),
    ],
    data: ethers.AbiCoder.defaultAbiCoder().encode(
      ['uint128', 'uint64', 'bytes32'],
      [2_500_000n, 1_736_000_000n, ethers.id('commit')]
    ),
  };

  const parsed = market.interface.parseLog(log);
  assert.ok(parsed);
  assert.equal(parsed.name, 'JobSettled');
  const [j, o, b, gross, completedAt] = parsed.args as unknown as [string, string, string, bigint, bigint];
  assert.equal(j, jobId);
  assert.equal(o.toLowerCase(), operator);
  assert.equal(b.toLowerCase(), buyer);
  assert.equal(gross, 2_500_000n);
  assert.equal(completedAt, 1_736_000_000n);
});

algo('buildVerifyData produces a chain-key-guarded verifyAndRegister call', async () => {
  const vault = new Contract(ethers.ZeroAddress, vaultAbi);
  const proof = {
    chainKey: 1,
    headerNumber: 1000,
    txIndex: 0,
    txHash: `0x${'12'.repeat(32)}`,
    txBytes: `0x${'34'.repeat(64)}`,
    merkleProof: {
      root: `0x${'ab'.repeat(32)}`,
      siblings: [
        { hash: `0x${'cd'.repeat(32)}`, isLeft: true },
        { hash: `0x${'ef'.repeat(32)}`, isLeft: false },
      ],
    },
    continuityProof: {
      lowerEndpointDigest: `0x${'01'.repeat(32)}`,
      roots: [`0x${'23'.repeat(32)}`, `0x${'45'.repeat(32)}`],
    },
    cached: true,
    generatedAt: new Date(),
  };

  const data = buildVerifyData(vault, proof);
  const decoded = vault.interface.parseTransaction({ data });
  assert.ok(decoded);
  assert.equal(decoded.name, 'verifyAndRegister');
  const [chainKey, height, txBytes, merkleRoot, siblings, lowerEndpointDigest, roots] = decoded.args as unknown as [
    bigint,
    bigint,
    string,
    string,
    { hash: string; isLeft: boolean }[],
    string,
    string[],
  ];
  assert.equal(chainKey, 1n);
  assert.equal(height, 1000n);
  assert.equal(txBytes, proof.txBytes);
  assert.equal(merkleRoot, proof.merkleProof.root);
  assert.equal(siblings.length, 2);
  assert.equal(siblings[0]!.hash, proof.merkleProof.siblings[0]!.hash);
  assert.equal(lowerEndpointDigest, proof.continuityProof.lowerEndpointDigest);
  assert.deepEqual(Array.from(roots), proof.continuityProof.roots);
});

algo('revert classification sends idempotent/end-state errors to terminal', () => {
  assert.ok(isTerminalRevert('ComputeCredVault: job already used'));
  assert.ok(isTerminalRevert('Query already processed'));
  assert.ok(isTerminalRevert('ComputeCredVault: wrong source chain'));
  assert.ok(isTerminalRevert('ComputeCredVault: unsupported tx type'));
  assert.ok(isTerminalRevert('ComputeCredVault: invalid JobSettled data'));
  assert.ok(!isTerminalRevert('RPC error: connection reset'));
  assert.ok(!isTerminalRevert('ComputeCredVault: insufficient liquidity'));
  assert.ok(!isTerminalRevert('ComputeCredVault: over repay'));
});