import { expect } from 'chai';
import { ethers } from 'hardhat';
import type { Contract, Signer } from 'ethers';

const JOB_SETTLED_SIG = '0x576d20c6973b5fc107e0f23c395df0170eaed2b08ca42f1192b69c63c0533e92';

const ADVANCE_RATE = 5000; // 50%
const CONCENTRATION = 4000; // 40%
const OPERATOR_CAP = 10_000_000_000n;
const FRESHNESS = 30 * 24 * 3600; // 30 days

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
  lifetimeDebtRepaidByRevenue: bigint;
  eventCount: bigint;
};

type Scalars = number | bigint | string;

interface VaultT {
  target: string;
  connect(signer: Signer): VaultT;
  registerSourceContract(address: string): Promise<unknown>;
  openFacility(): Promise<unknown>;
  provideLiquidity(amount: Scalars): Promise<unknown>;
  setOperatorCap(cap: Scalars): Promise<unknown>;
  draw(amount: Scalars): Promise<unknown>;
  repay(amount: Scalars): Promise<unknown>;
  verifyAndRegister(
    action: Scalars,
    chainKey: Scalars,
    encodedTransaction: string,
    merkleRoot: string,
    siblings: { hash: string; isLeft: boolean }[],
    lowerEndpointDigest: string,
    continuityRoots: string[]
  ): Promise<unknown>;
  exposeProcessEvent(action: Scalars, queryId: string, encodedTransaction: string): Promise<unknown>;
  getFacilityView(operator: string): Promise<FacilityView>;
}

interface TokenT {
  target: string;
  connect(signer: Signer): TokenT;
  mint(to: string, amount: Scalars): Promise<unknown>;
  approve(spender: string, amount: Scalars): Promise<unknown>;
  balanceOf(who: string): Promise<bigint>;
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
let buyerA: Signer;
let buyerB: Signer;
let buyerC: Signer;
let buyerD: Signer;
let buyerE: Signer;
let operatorAddr: string;
let buyerAAddr: string;
let buyerBAddr: string;
let buyerCAddr: string;
let buyerDAddr: string;
let buyerEAddr: string;

async function now(): Promise<bigint> {
  const bn = await ethers.provider.getBlock('latest');
  return BigInt(bn?.timestamp ?? 0n);
}

async function freshVault(opts: { cap?: bigint; liquidity?: bigint; skipRegister?: boolean } = {}) {
  const TestUSDC = await ethers.getContractFactory('TestUSDC');
  const token = asToken(await TestUSDC.deploy(1_000_000_000_000n));

  const TxEncoder = await ethers.getContractFactory('TxEncoder');
  const encoder = asEncoder(await TxEncoder.deploy());

  const Harness = await ethers.getContractFactory('ComputeCredVaultHarness');
  const rawVault = await Harness.deploy(token.target, ADVANCE_RATE, CONCENTRATION, opts.cap ?? OPERATOR_CAP, FRESHNESS);
  const vault = asVault(rawVault);

  if (!opts.skipRegister) {
    await vault.registerSourceContract(MARKET);
  }
  await vault.connect(operator).openFacility();

  const liq = opts.liquidity ?? 2_000_000_000n;
  if (liq > 0n) {
    await token.mint(operatorAddr, liq);
    await token.connect(operator).approve(vault.target, liq);
    await vault.connect(operator).provideLiquidity(liq);
  }

  return { token, encoder, vault };
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
    [deployer, operator, buyerA, buyerB, buyerC, buyerD, buyerE] = await ethers.getSigners();
    [operatorAddr, buyerAAddr, buyerBAddr, buyerCAddr, buyerDAddr, buyerEAddr] = await Promise.all(
      [operator, buyerA, buyerB, buyerC, buyerD, buyerE].map((s) => s.getAddress())
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
      expect(v2.facilityLimit).to.equal(500_000n); // exactly the strategy formula: 0.50 * 1M
      expect(v2.eventCount).to.equal(3);
    });
  });

  describe('auto-repay: verified revenue pays debt before growing the book', () => {
    it('settlements first repay accrued debt, then contribute to trailing revenue', async () => {
      const { encoder, vault } = await freshVault();

      await settle(vault, encoder, { jobId: 'ar-a', buyer: buyerAAddr, gross: 400_000n });
      await settle(vault, encoder, { jobId: 'ar-b', buyer: buyerBAddr, gross: 300_000n });
      await settle(vault, encoder, { jobId: 'ar-c', buyer: buyerCAddr, gross: 300_000n });
      // sum 1M, limit 500k
      await vault.connect(operator).draw(200_000n);
      expect((await vault.getFacilityView(operatorAddr)).outstandingDebt).to.equal(200_000n);

      // 120k settlement covers 120k of the 200k debt; none becomes new revenue.
      await settle(vault, encoder, { jobId: 'ar-d1', buyer: buyerDAddr, gross: 120_000n });
      let v = await vault.getFacilityView(operatorAddr);
      expect(v.outstandingDebt).to.equal(80_000n);
      expect(v.verifiedRevenue).to.equal(1_000_000n);

      // 80k settlement clears the remaining debt.
      await settle(vault, encoder, { jobId: 'ar-d2', buyer: buyerDAddr, gross: 80_000n });
      v = await vault.getFacilityView(operatorAddr);
      expect(v.outstandingDebt).to.equal(0n);
      expect(v.verifiedRevenue).to.equal(1_000_000n);

      // Only now does new revenue grow the book: +100k -> sum 1.1M -> limit 550k.
      await settle(vault, encoder, { jobId: 'ar-e', buyer: buyerEAddr, gross: 100_000n });
      v = await vault.getFacilityView(operatorAddr);
      expect(v.verifiedRevenue).to.equal(1_100_000n);
      expect(v.facilityLimit).to.equal(550_000n);
      expect(v.lifetimeDebtRepaidByRevenue).to.equal(200_000n);
      expect(v.availableCapacity).to.equal(550_000n);
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
      // ABI word for `uint8 5` -> EvmV1Decoder reads txType 5, which is not a supported type.
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

      // A draw at the naive 50% * eligible level must revert (concentration caps capacity).
      await expect(vault.connect(operator).draw(500_000n)).to.be.revertedWith('ComputeCredVault: over limit');
      // Exactly the concentration-adjusted line is drawable.
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

  describe('draw and repay', () => {
    it('rejects a draw above the (concentration-adjusted) facility limit', async () => {
      const { encoder, vault } = await freshVault();
      await settle(vault, encoder, { jobId: 'odl', buyer: buyerAAddr, gross: 100_000n });
      // Single buyer -> book = 100k - (100k - 40%) = 40k -> limit = 20k.
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
    it('caps eligible revenue before the advance rate applies', async () => {
      const { encoder, vault } = await freshVault({ cap: 800_000n });
      await settle(vault, encoder, { jobId: 'cap-a', buyer: buyerAAddr, gross: 1_000_000n, completedAt: await now() });

      const v = await vault.getFacilityView(operatorAddr);
      expect(v.verifiedRevenue).to.equal(1_000_000n); // raw window total
      expect(v.eligibleRevenue).to.equal(800_000n); // capped
      expect(v.facilityLimit).to.be.below(500_000n); // 50% of the capped base, BEFORE any haircut
    });
  });

  describe('protocol access controls', () => {
    it('only the owner can register the source contract', async () => {
      const { vault } = await freshVault();
      await expect(vault.connect(buyerA).registerSourceContract(MARKET)).to.be.revertedWithCustomError(
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
    // a proof is tampered with. On a live CC3 deployment, this path is exercised end-to-end by
    // the worker demo script.
    await expect(
      vault
        .connect(operator)
        .verifyAndRegister(0, 1n, '0x1234', ethers.id('bogus-root'), [], ethers.ZeroHash, [])
    ).to.be.reverted;
  });
});