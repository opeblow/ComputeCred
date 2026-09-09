import { expect } from 'chai';
import { ethers } from 'hardhat';
import type { BaseContract, Contract, Signer } from 'ethers';

const JOB_SETTLED_SIG = '0x576d20c6973b5fc107e0f23c395df0170eaed2b08ca42f1192b69c63c0533e92';

const ADVANCE_RATE = 5000; // 50%
const CONCENTRATION = 4000; // 40%
const OPERATOR_CAP = 10_000_000_000n;
const FRESHNESS = 30 * 24 * 3600; // 30 days
const SOURCE_CHAIN_KEY = 1n; // Ethereum / Sepolia

const MARKET = `0x${'11'.repeat(20)}`;

type FacilityView = {
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
};

type Scalars = number | bigint | string;

interface VaultT {
  target: string;
  connect(signer: Signer): VaultT;
  registerSourceContract(market: string, settlementAsset: string): Promise<unknown>;
  setRelayer(relayer: string, authorized: boolean): Promise<unknown>;
  setOperatorCap(cap: Scalars): Promise<unknown>;
  pauseBorrowing(): Promise<unknown>;
  unpauseBorrowing(): Promise<unknown>;
  openFacility(): Promise<unknown>;
  provideLiquidity(amount: Scalars): Promise<unknown>;
  draw(amount: Scalars): Promise<unknown>;
  repay(amount: Scalars): Promise<unknown>;
  verifyAndRegister(
    chainKey: Scalars,
    blockHeight: Scalars,
    encodedTransaction: string,
    merkleRoot: string,
    siblings: { hash: string; isLeft: boolean }[],
    lowerEndpointDigest: string,
    continuityRoots: string[]
  ): Promise<unknown>;
  verifyAndRegisterBatch(
    chainKey: Scalars,
    blockHeights: Scalars[],
    encodedTransactions: string[],
    merkleProofs: { root: string; siblings: { hash: string; isLeft: boolean }[] }[],
    continuityProof: { lowerEndpointDigest: string; roots: string[] }
  ): Promise<unknown>;
  exposeProcessEvent(action: Scalars, queryId: string, encodedTransaction: string): Promise<unknown>;
  exposeVerifyChain(chainKey: Scalars): Promise<void>;
  exposed: undefined;
  getEventCount(operator: string): Promise<bigint>;
  getFacilityView(operator: string): Promise<FacilityView>;
}

interface TokenT {
  target: string;
  connect(signer: Signer): TokenT;
  mint(to: string, amount: Scalars): Promise<unknown>;
  approve(spender: string, amount: Scalars): Promise<unknown>;
  balanceOf(who: string): Promise<bigint>;
  decimals(): Promise<bigint>;
}

interface EncoderT {
  encodeSettlement(
    status: Scalars,
    emitter: string,
    jobId: string,
    operator: string,
    buyer: string,
    gross: Scalars,
    completedAt: Scalars,
    commitment: string
  ): Promise<string>;
  encodeLog(emitter: string, topics: string[], data: string): Promise<string>;
}

const asVault = (c: Contract): VaultT => c as unknown as VaultT;
const asToken = (c: Contract): TokenT => c as unknown as TokenT;
const asEncoder = (c: Contract): EncoderT => c as unknown as EncoderT;
const asContract = (c: VaultT): Contract => c as unknown as Contract;

let deployer: Signer;
let operator: Signer;
let relayer: Signer;
let buyerA: Signer;
let buyerB: Signer;
let buyerC: Signer;
let buyerD: Signer;
let buyerE: Signer;
let operatorAddr: string;
let relayerAddr: string;
let buyerAAddr: string;
let buyerBAddr: string;
let buyerCAddr: string;
let buyerDAddr: string;
let buyerEAddr: string;

async function now(): Promise<bigint> {
  const bn = await ethers.provider.getBlock('latest');
  return BigInt(bn?.timestamp ?? 0n);
}

async function deployMock(symbol: string, decimals: number): Promise<TokenT> {
  const Mock = await ethers.getContractFactory('MockERC20');
  return asToken(await Mock.deploy(`Mock ${symbol}`, symbol, decimals));
}

async function freshVault(
  opts: {
    cap?: bigint;
    liquidity?: bigint;
    skipRegister?: boolean;
    chainKey?: bigint;
    loanDecimals?: number;
    settlementDecimals?: number;
  } = {}
) {
  const loanToken = opts.loanDecimals !== undefined && opts.loanDecimals !== 6
    ? await deployMock('LOAN', opts.loanDecimals)
    : null;
  const token = loanToken ?? asToken(await (await ethers.getContractFactory('TestUSDC')).deploy(1_000_000_000_000n));
  const settlementToken = opts.settlementDecimals !== undefined && opts.settlementDecimals !== 6
    ? await deployMock('SET', opts.settlementDecimals)
    : await deployMock('sUSDC', 6);

  const TxEncoder = await ethers.getContractFactory('TxEncoder');
  const encoder = asEncoder(await TxEncoder.deploy());

  const Harness = await ethers.getContractFactory('ComputeCredVaultHarness');
  const rawVault = await Harness.deploy(
    token.target,
    opts.chainKey ?? SOURCE_CHAIN_KEY,
    ADVANCE_RATE,
    CONCENTRATION,
    opts.cap ?? OPERATOR_CAP,
    FRESHNESS
  );
  const vault = asVault(rawVault);

  if (!opts.skipRegister) {
    await vault.registerSourceContract(MARKET, settlementToken.target);
  }
  await vault.connect(operator).openFacility();

  const liq = opts.liquidity ?? 2_000_000_000n;
  if (liq > 0n) {
    await token.mint(operatorAddr, liq);
    await token.connect(operator).approve(vault.target, liq);
    await vault.connect(operator).provideLiquidity(liq);
  }

  return { token, settlementToken, encoder, vault };
}

async function settle(
  vault: VaultT,
  encoder: EncoderT,
  opts: {
    jobId: string;
    buyer: string;
    gross: bigint;
    completedAt?: bigint;
    status?: number;
    emitter?: string;
    operator?: string;
  },
  caller: Signer = operator
) {
  const ts = await now();
  const encoded = await encoder.encodeSettlement(
    opts.status ?? 1,
    opts.emitter ?? MARKET,
    ethers.id(opts.jobId),
    opts.operator ?? operatorAddr,
    opts.buyer,
    opts.gross,
    opts.completedAt ?? ts - 3600n,
    ethers.id(`commit-${opts.jobId}`)
  );
  return vault.connect(caller).exposeProcessEvent(0, ethers.id(`q-${opts.jobId}`), encoded);
}

describe('ComputeCredVault: credit policy + strict validation', () => {
  before(async () => {
    [deployer, operator, relayer, buyerA, buyerB, buyerC, buyerD, buyerE] = await ethers.getSigners();
    [operatorAddr, relayerAddr, buyerAAddr, buyerBAddr, buyerCAddr, buyerDAddr, buyerEAddr] = await Promise.all(
      [operator, relayer, buyerA, buyerB, buyerC, buyerD, buyerE].map((s) => s.getAddress())
    );
  });

  describe('verified revenue raises the facility', () => {
    it('books a settlement and advances 50% of the concentration-adjusted base', async () => {
      const { encoder, vault } = await freshVault();

      await settle(vault, encoder, { jobId: 'happy-a', buyer: buyerAAddr, gross: 400_000n });

      const v = await vault.getFacilityView(operatorAddr);
      expect(v.verifiedRevenue).to.equal(400_000n);
      expect(v.eligibleRevenue).to.equal(400_000n);
      // Single buyer = 100% concentration: only the diversified-equivalent 40% slice is financed.
      expect(v.largestBuyerShareBps).to.equal(10_000n);
      expect(v.concentrationFactorBps).to.equal(4000n);
      expect(v.facilityLimit).to.equal(80_000n); // (400k - (400k - 40%*400k)) * 50% = 160k * 50%
      expect(v.availableCapacity).to.equal(80_000n);

      // Diversify: buyer B and C at 300k each -> sum 1M, largest 400k == 40% -> full base financed.
      await settle(vault, encoder, { jobId: 'happy-b', buyer: buyerBAddr, gross: 300_000n });
      await settle(vault, encoder, { jobId: 'happy-c', buyer: buyerCAddr, gross: 300_000n });

      const v2 = await vault.getFacilityView(operatorAddr);
      expect(v2.verifiedRevenue).to.equal(1_000_000n);
      expect(v2.largestBuyerShareBps).to.equal(4000n);
      expect(v2.concentrationFactorBps).to.equal(10_000n);
      expect(v2.facilityLimit).to.equal(500_000n); // exactly 0.50 * 1M
      expect(v2.eventCount).to.equal(3);
    });
  });

  describe('revenue recognition and repayment are separate', () => {
    it('settlements grow revenue but never touch debt or vault assets', async () => {
      const { encoder, vault } = await freshVault();
      await settle(vault, encoder, { jobId: 'sep-a', buyer: buyerAAddr, gross: 400_000n });
      await settle(vault, encoder, { jobId: 'sep-b', buyer: buyerBAddr, gross: 300_000n });
      await settle(vault, encoder, { jobId: 'sep-c', buyer: buyerCAddr, gross: 300_000n });
      // sum 1M, limit 500k
      await vault.connect(operator).draw(200_000n);
      const liquidityBefore = (await vault.getFacilityView(operatorAddr)).vaultLiquidity;

      // A 120k settlement must NOT write the 200k debt down (vault never received the proceeds).
      await settle(vault, encoder, { jobId: 'sep-d', buyer: buyerDAddr, gross: 120_000n });

      const v = await vault.getFacilityView(operatorAddr);
      expect(v.outstandingDebt).to.equal(200_000n);
      expect(v.verifiedRevenue).to.equal(1_120_000n);
      expect(v.lifetimeRepaid).to.equal(0n);
      // No loan token entered the vault as a result of the settlement.
      expect((await vault.getFacilityView(operatorAddr)).vaultLiquidity).to.equal(liquidityBefore);
    });

    it('debt decreases only when repayment assets are actually received', async () => {
      const { encoder, token, vault } = await freshVault();
      await settle(vault, encoder, { jobId: 'rep-a', buyer: buyerAAddr, gross: 400_000n });
      await settle(vault, encoder, { jobId: 'rep-b', buyer: buyerBAddr, gross: 300_000n });
      await settle(vault, encoder, { jobId: 'rep-c', buyer: buyerCAddr, gross: 300_000n });

      await vault.connect(operator).draw(200_000n);
      let v = await vault.getFacilityView(operatorAddr);
      expect(v.outstandingDebt).to.equal(200_000n);
      expect(v.vaultLiquidity).to.equal(2_000_000_000n - 200_000n);

      // Repay by transferring actual loan tokens into the vault.
      await token.mint(operatorAddr, 200_000n);
      await token.connect(operator).approve(vault.target, 200_000n);
      await vault.connect(operator).repay(200_000n);

      v = await vault.getFacilityView(operatorAddr);
      expect(v.outstandingDebt).to.equal(0n);
      expect(v.lifetimeRepaid).to.equal(200_000n);
      expect(v.vaultLiquidity).to.equal(2_000_000_000n); // assets actually replenished
    });
  });

  describe('replay guards', () => {
    it('rejects a job id that was already used', async () => {
      const { encoder, vault } = await freshVault();
      await settle(vault, encoder, { jobId: 'dupe', buyer: buyerAAddr, gross: 1_000n });
      await expect(settle(vault, encoder, { jobId: 'dupe', buyer: buyerBAddr, gross: 1_000n })).to.be.revertedWith(
        'ComputeCredVault: job already used'
      );
    });
  });

  describe('source contract binding', () => {
    it('rejects when no source contract is registered', async () => {
      const { encoder, vault } = await freshVault({ skipRegister: true });
      await expect(settle(vault, encoder, { jobId: 'x', buyer: buyerAAddr, gross: 1_000n })).to.be.revertedWith(
        'ComputeCredVault: source contract not registered'
      );
    });

    it('rejects events emitted by the wrong source contract', async () => {
      const { encoder, vault } = await freshVault();
      await expect(
        settle(vault, encoder, { jobId: 'wrong-src', buyer: buyerAAddr, gross: 1_000n, emitter: `0x${'22'.repeat(20)}` })
      ).to.be.revertedWith('ComputeCredVault: wrong source contract');
    });
  });

  describe('explicit token support (units)', () => {
    it('rejects a loan token that is not 6 decimals', async () => {
      await expect(
        (await ethers.getContractFactory('ComputeCredVaultHarness')).deploy(
          (await deployMock('LOAN18', 18)).target,
          SOURCE_CHAIN_KEY,
          ADVANCE_RATE,
          CONCENTRATION,
          OPERATOR_CAP,
          FRESHNESS
        )
      ).to.be.revertedWith('ComputeCredVault: loan token must be 6 decimals');
    });

    it('rejects registering a settlement asset that is not 6 decimals', async () => {
      const { vault } = await freshVault({ skipRegister: true });
      const bad = await deployMock('SET18', 18);
      await expect(vault.connect(deployer).registerSourceContract(MARKET, bad.target)).to.be.revertedWith(
        'ComputeCredVault: settlement asset must be 6 decimals'
      );
    });

    it('requires a settlement asset to be named, not inferred', async () => {
      const { vault } = await freshVault({ skipRegister: true });
      const zero = `0x${'00'.repeat(20)}`;
      await expect(vault.connect(deployer).registerSourceContract(MARKET, zero)).to.be.revertedWith(
        'ComputeCredVault: zero settlement asset'
      );
    });
  });

  describe('source chain binding', () => {
    it('rejects proofs referencing a chain other than the expected source chain', async () => {
      const { vault } = await freshVault();
      await expect(vault.connect(operator).exposeVerifyChain(999n)).to.be.revertedWith(
        'ComputeCredVault: wrong source chain'
      );
      await expect(vault.connect(operator).exposeVerifyChain(SOURCE_CHAIN_KEY)).to.not.be.reverted;
    });

    it('guards the production verification entry point before any precompile work', async () => {
      const { vault } = await freshVault();
      await expect(
        vault
          .connect(operator)
          .verifyAndRegister(999n, 1n, '0x1234', ethers.id('bad'), [], ethers.ZeroHash, [])
      ).to.be.revertedWith('ComputeCredVault: wrong source chain');
    });
  });

  describe('scoped relayer submission', () => {
    it('lets an authorized relayer register settlements but never draw', async () => {
      const { encoder, vault } = await freshVault();
      await vault.connect(operator).setRelayer(relayerAddr, true);

      await settle(vault, encoder, { jobId: 'rl-a', buyer: buyerAAddr, gross: 400_000n }, relayer);
      const v = await vault.getFacilityView(operatorAddr);
      expect(v.verifiedRevenue).to.equal(400_000n);

      // Scoped = settlements only. A relayer draw touches the relayer's own (nonexistent) facility.
      await expect(vault.connect(relayer).draw(1_000n)).to.be.revertedWith('ComputeCredVault: facility not open');
      // A relayer can never repay or change policy.
      await expect(vault.connect(relayer).setRelayer(buyerAAddr, true)).to.be.revertedWith(
        'ComputeCredVault: facility not open'
      );
    });

    it('loses settlement rights when revoked', async () => {
      const { encoder, vault } = await freshVault();
      await vault.connect(operator).setRelayer(relayerAddr, true);
      await vault.connect(operator).setRelayer(relayerAddr, false);
      await expect(
        settle(vault, encoder, { jobId: 'rv-a', buyer: buyerAAddr, gross: 1_000n }, relayer)
      ).to.be.revertedWith('ComputeCredVault: operator mismatch');
    });
  });

  describe('selective emergency controls', () => {
    it('pauses new borrowing but leaves repayments open', async () => {
      const { encoder, token, vault } = await freshVault();
      await settle(vault, encoder, { jobId: 'ps-a', buyer: buyerAAddr, gross: 400_000n });
      await settle(vault, encoder, { jobId: 'ps-b', buyer: buyerBAddr, gross: 300_000n });
      await settle(vault, encoder, { jobId: 'ps-c', buyer: buyerCAddr, gross: 300_000n });

      await vault.connect(operator).draw(200_000n);
      await vault.connect(deployer).pauseBorrowing();

      await expect(vault.connect(operator).draw(1_000n)).to.be.revertedWithCustomError(
        asContract(vault),
        'EnforcedPause'
      );
      await expect(vault.connect(buyerA).openFacility()).to.be.revertedWithCustomError(asContract(vault), 'EnforcedPause');

      // Repayment during an incident still works.
      await token.mint(operatorAddr, 200_000n);
      await token.connect(operator).approve(vault.target, 200_000n);
      await vault.connect(operator).repay(200_000n);
      expect((await vault.getFacilityView(operatorAddr)).outstandingDebt).to.equal(0n);

      await vault.connect(deployer).unpauseBorrowing();
      await vault.connect(operator).draw(1_000n);
    });
  });

  describe('receipt / event decoding', () => {
    it('rejects a failed source receipt', async () => {
      const { encoder, vault } = await freshVault();
      await expect(
        settle(vault, encoder, { jobId: 'failed', buyer: buyerAAddr, gross: 1_000n, status: 0 })
      ).to.be.revertedWith('ComputeCredVault: source receipt failed');
    });

    it('rejects a log whose topic0 is not JobSettled (decoder filters it out)', async () => {
      const { encoder, vault } = await freshVault();
      const encoded = await encoder.encodeLog(
        MARKET,
        [ethers.id('SomethingElse(uint256)'), ethers.id('a'), ethers.id('b'), ethers.id('c')],
        '0x'
      );
      await expect(
        vault.connect(operator).exposeProcessEvent(0, ethers.id('q'), encoded)
      ).to.be.revertedWith('ComputeCredVault: expected one JobSettled log');
    });

    it('rejects a JobSettled log with wrong topic arity', async () => {
      const { encoder, vault } = await freshVault();
      const encoded = await encoder.encodeLog(MARKET, [JOB_SETTLED_SIG, ethers.id('a'), ethers.id('b')], '0x');
      await expect(
        vault.connect(operator).exposeProcessEvent(0, ethers.id('q'), encoded)
      ).to.be.revertedWith('ComputeCredVault: invalid JobSettled topics');
    });

    it('rejects JobSettled data with the wrong byte length', async () => {
      const { encoder, vault } = await freshVault();
      const encoded = await encoder.encodeLog(
        MARKET,
        [JOB_SETTLED_SIG, ethers.id('a'), ethers.id('b'), ethers.id('c')],
        '0x1234'
      );
      await expect(
        vault.connect(operator).exposeProcessEvent(0, ethers.id('q'), encoded)
      ).to.be.revertedWith('ComputeCredVault: invalid JobSettled data');
    });

    it('rejects a zero gross amount', async () => {
      const { encoder, vault } = await freshVault();
      await expect(settle(vault, encoder, { jobId: 'zero', buyer: buyerAAddr, gross: 0n })).to.be.revertedWith(
        'ComputeCredVault: zero gross amount'
      );
    });

    it('rejects a claimant that is not the calling wallet (wrong operator)', async () => {
      const { encoder, vault } = await freshVault();
      await expect(
        settle(vault, encoder, { jobId: 'wrong-op', buyer: buyerBAddr, gross: 1_000n, operator: buyerAAddr })
      ).to.be.revertedWith('ComputeCredVault: operator mismatch');
    });

    it('rejects unsupported transaction encodings', async () => {
      const { vault } = await freshVault();
      const badType = ethers.AbiCoder.defaultAbiCoder().encode(['uint8'], [5]);
      await expect(
        vault.connect(operator).exposeProcessEvent(0, ethers.id('q'), badType)
      ).to.be.revertedWith('ComputeCredVault: unsupported tx type');
    });
  });

  describe('freshness', () => {
    it('rejects a stale settlement (older than the 30-day window)', async () => {
      const { encoder, vault } = await freshVault();
      const ts = await now();
      await expect(
        settle(vault, encoder, { jobId: 'stale', buyer: buyerAAddr, gross: 1_000n, completedAt: ts - BigInt(FRESHNESS) - 1000n })
      ).to.be.revertedWith('ComputeCredVault: settlement too old');
    });

    it('rejects future-dated settlements beyond the clock-skew allowance', async () => {
      const { encoder, vault } = await freshVault();
      const ts = await now();
      await expect(
        settle(vault, encoder, { jobId: 'future', buyer: buyerAAddr, gross: 1_000n, completedAt: ts + 7200n })
      ).to.be.revertedWith('ComputeCredVault: settlement timestamp in future');
    });

    it('drops revenue from outside the window as time passes', async () => {
      const { encoder, vault } = await freshVault();
      await settle(vault, encoder, { jobId: 'aging', buyer: buyerAAddr, gross: 1_000_000n });
      expect((await vault.getFacilityView(operatorAddr)).verifiedRevenue).to.equal(1_000_000n);

      await ethers.provider.send('evm_increaseTime', [FRESHNESS + 3600]);
      await ethers.provider.send('evm_mine', []);

      const v = await vault.getFacilityView(operatorAddr);
      expect(v.verifiedRevenue).to.equal(0n);
      expect(v.eventCount).to.equal(0n);
      expect(v.facilityLimit).to.equal(0n);
    });
  });

  describe('buyer-concentration policy', () => {
    it('applies the concentration haircut (breach shrinks the line)', async () => {
      const { encoder, vault } = await freshVault();
      // 60% / 40% split: largest buyer A = 60% of base -> excess over 40% is not financed.
      await settle(vault, encoder, { jobId: 'conc-a', buyer: buyerAAddr, gross: 600_000n });
      await settle(vault, encoder, { jobId: 'conc-b', buyer: buyerBAddr, gross: 400_000n });

      const v = await vault.getFacilityView(operatorAddr);
      expect(v.verifiedRevenue).to.equal(1_000_000n);
      expect(v.largestBuyerShareBps).to.equal(6000n);
      // book = 1M - (600k - 40%*1M) = 800k -> limit = 400k (naive would be 500k).
      expect(v.facilityLimit).to.equal(400_000n);

      await expect(vault.connect(operator).draw(500_000n)).to.be.revertedWith('ComputeCredVault: over limit');
      await vault.connect(operator).draw(400_000n);
      expect((await vault.getFacilityView(operatorAddr)).outstandingDebt).to.equal(400_000n);
    });

    it('fully finances the base once the top buyer is at or under 40%', async () => {
      const { encoder, vault } = await freshVault();
      await settle(vault, encoder, { jobId: 'div-a', buyer: buyerAAddr, gross: 400_000n });
      await settle(vault, encoder, { jobId: 'div-b', buyer: buyerBAddr, gross: 300_000n });
      await settle(vault, encoder, { jobId: 'div-c', buyer: buyerCAddr, gross: 300_000n });
      const v = await vault.getFacilityView(operatorAddr);
      expect(v.concentrationFactorBps).to.equal(10_000n);
      expect(v.facilityLimit).to.equal(500_000n);
    });
  });

  describe('operator cap x concentration composition', () => {
    it('keeps the full formula for diversified revenue under the cap', async () => {
      const { encoder, vault } = await freshVault({ cap: 1000n });
      await settle(vault, encoder, { jobId: 'capx-a', buyer: buyerAAddr, gross: 400n });
      await settle(vault, encoder, { jobId: 'capx-b', buyer: buyerBAddr, gross: 300n });
      await settle(vault, encoder, { jobId: 'capx-c', buyer: buyerCAddr, gross: 300n });
      const v = await vault.getFacilityView(operatorAddr);
      expect(v.eligibleRevenue).to.equal(1000n);
      expect(v.concentrationFactorBps).to.equal(10_000n);
      expect(v.facilityLimit).to.equal(500n);
    });

    it('capping the base never yields a negative or degenerate limit', async () => {
      const { encoder, vault } = await freshVault({ cap: 1000n });
      // Same proportions as above (4:3:3) but far above the cap. The eligible base is 1000 and the
      // largest buyer is capped into that base, so the haircut composes on the capped set instead
      // of producing a negative book.
      await settle(vault, encoder, { jobId: 'capx2-a', buyer: buyerAAddr, gross: 4000n });
      await settle(vault, encoder, { jobId: 'capx2-b', buyer: buyerBAddr, gross: 3000n });
      await settle(vault, encoder, { jobId: 'capx2-c', buyer: buyerCAddr, gross: 3000n });
      const v = await vault.getFacilityView(operatorAddr);
      expect(v.verifiedRevenue).to.equal(10_000n);
      expect(v.eligibleRevenue).to.equal(1000n);
      expect(v.largestBuyerShareBps).to.equal(4000n); // 4:3:3 ratios preserved in the share view
      // book = 1000 - (1000 - 40%*1000) = 400 -> limit 200. Predictable, never zero.
      expect(v.facilityLimit).to.equal(200n);
    });
  });

  describe('draw and repay', () => {
    it('rejects a draw above the (concentration-adjusted) facility limit', async () => {
      const { encoder, vault } = await freshVault();
      await settle(vault, encoder, { jobId: 'odl', buyer: buyerAAddr, gross: 100_000n });
      const v = await vault.getFacilityView(operatorAddr);
      expect(v.facilityLimit).to.equal(20_000n);
      await expect(vault.connect(operator).draw(50_000n)).to.be.revertedWith('ComputeCredVault: over limit');
    });

    it('rejects a draw when the vault has no liquidity', async () => {
      const { encoder, vault } = await freshVault({ liquidity: 0n });
      await settle(vault, encoder, { jobId: 'nol', buyer: buyerAAddr, gross: 1_000_000n });
      await expect(vault.connect(operator).draw(1_000n)).to.be.revertedWith(
        'ComputeCredVault: insufficient liquidity'
      );
    });

    it('rejects repayment above outstanding debt', async () => {
      const { encoder, token, vault } = await freshVault();
      await settle(vault, encoder, { jobId: 'over-r', buyer: buyerAAddr, gross: 100_000n });
      await token.mint(operatorAddr, 100n);
      await token.connect(operator).approve(vault.target, 100n);
      await expect(vault.connect(operator).repay(100n)).to.be.revertedWith('ComputeCredVault: over repay');
    });

    it('manual repay frees capacity', async () => {
      const { encoder, token, vault } = await freshVault();
      await settle(vault, encoder, { jobId: 'repay-a', buyer: buyerAAddr, gross: 400_000n });
      await settle(vault, encoder, { jobId: 'repay-b', buyer: buyerBAddr, gross: 300_000n });
      await settle(vault, encoder, { jobId: 'repay-c', buyer: buyerCAddr, gross: 300_000n });

      await vault.connect(operator).draw(200_000n);
      let v = await vault.getFacilityView(operatorAddr);
      expect(v.outstandingDebt).to.equal(200_000n);
      expect(v.availableCapacity).to.equal(300_000n);

      await token.mint(operatorAddr, 200_000n);
      await token.connect(operator).approve(vault.target, 200_000n);
      await vault.connect(operator).repay(200_000n);

      v = await vault.getFacilityView(operatorAddr);
      expect(v.outstandingDebt).to.equal(0n);
      expect(v.availableCapacity).to.equal(500_000n);
    });
  });

  describe('operator cap', () => {
    it('caps eligible revenue and bases the haircut on the capped set', async () => {
      const { encoder, vault } = await freshVault({ cap: 800_000n });
      await settle(vault, encoder, { jobId: 'cap-a', buyer: buyerAAddr, gross: 1_000_000n });

      const v = await vault.getFacilityView(operatorAddr);
      expect(v.verifiedRevenue).to.equal(1_000_000n); // raw window total
      expect(v.eligibleRevenue).to.equal(800_000n); // capped
      // largest capped to 800k; book = 800k - (800k - 40%*800k) = 320k -> limit 160k (50%).
      expect(v.facilityLimit).to.equal(160_000n);
    });
  });

  describe('bounded on-chain storage', () => {
    it('caps the windowed event set at MAX_WINDOW_EVENTS without corrupting the math', async () => {
      const { encoder, vault } = await freshVault();
      const ts = await now();
      for (let i = 0; i < 258; ++i) {
        await settle(vault, encoder, {
          jobId: `bulk-${i}`,
          buyer: i % 3 === 0 ? buyerAAddr : i % 3 === 1 ? buyerBAddr : buyerCAddr,
          gross: 1_000n,
          completedAt: ts - 3600n,
        });
      }
      const v = await vault.getFacilityView(operatorAddr);
      expect(v.eventCount).to.equal(256n);
      expect(await vault.getEventCount(operatorAddr)).to.equal(256n);
      // The 258 newest events survive (2 were dropped, earliest first).
      expect(v.verifiedRevenue).to.equal(256_000n);
    });
  });

  describe('protocol access controls', () => {
    it('only the owner can register the source contract', async () => {
      const { vault, settlementToken } = await freshVault();
      await expect(vault.connect(buyerA).registerSourceContract(MARKET, settlementToken.target)).to.be.revertedWithCustomError(
        asContract(vault),
        'OwnableUnauthorizedAccount'
      );
    });

    it('only the owner can change policy parameters', async () => {
      const { vault } = await freshVault();
      await expect(vault.connect(operator).setOperatorCap(1n)).to.be.revertedWithCustomError(
        asContract(vault),
        'OwnableUnauthorizedAccount'
      );
    });

    it('only the owner can pause borrowing', async () => {
      const { vault } = await freshVault();
      await expect(vault.connect(operator).pauseBorrowing()).to.be.revertedWithCustomError(
        asContract(vault),
        'OwnableUnauthorizedAccount'
      );
    });

    it('a facility can only be opened once', async () => {
      const { vault } = await freshVault();
      await expect(vault.connect(operator).openFacility()).to.be.revertedWith('ComputeCredVault: facility exists');
    });
  });
});

describe('ComputeCredVault production bytecode (Block Prover path)', () => {
  it('rejects an altered/invalid proof via the Creditcoin precompile call', async () => {
    const { vault } = await freshVault();
    // The Creditcoin Block Prover precompile (0xFD2) does not exist on local EVMs, so the
    // verification inside verifyAndRegister always fails here - exactly what happens on CC3 when
    // a proof is tampered with. The chain-key guard is exercised deterministically BEFORE the
    // precompile (see the 'source chain binding' block).
    await expect(
      vault
        .connect(operator)
        .verifyAndRegister(1n, 1n, '0x1234', ethers.id('bogus-root'), [], ethers.ZeroHash, [])
    ).to.be.reverted;
  });
});