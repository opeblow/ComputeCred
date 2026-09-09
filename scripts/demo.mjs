import { spawn } from 'node:child_process';
import { readFileSync, existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const BPS = 10000n;

const line = '─'.repeat(64);

function run(cmd, args) {
  return new Promise((resolve_) => {
    const child =
      process.platform === 'win32'
        ? spawn('cmd.exe', ['/d', '/s', '/c', `${cmd} ${args.join(' ')}`], { cwd: root, stdio: 'inherit' })
        : spawn(cmd, args, { cwd: root, stdio: 'inherit' });
    child.on('exit', (code) => resolve_(code));
  });
}

function haircut(eligibleShares) {
  const eligible = eligibleShares.reduce((a, b) => a + b, 0n);
  const largest = eligibleShares.reduce((a, b) => (a > b ? a : b), 0n);
  const excess = largest > (eligible * 40n) / 100n ? largest - (eligible * 40n) / 100n : 0n;
  const book = eligible - excess;
  return { eligible, largest, book, limit: (book * 50n) / 100n };
}

console.log(`\n${line}\n  ComputeCred — proof-backed revolving revenue financing\n${line}\n`);

console.log('Running the on-chain credit-policy test suite (local EVM)...\n');
const code = await run('npm', ['run', 'contracts:test']);
if (code !== 0) {
  console.error('\nTest suite failed — fix before demoing (npm run contracts:test).');
  process.exit(code);
}

console.log(`\n${line}\n  Credit policy tour — concentration haircut\n${line}\n`);
console.log('  eligible = min(<30d verified revenue>, operatorCap)   (50% advance rate)\n');
console.log(`  ${'Revenue mix (30d)'.padEnd(22)} ${'eligible'.padStart(9)} ${'book'.padStart(9)} ${''.padStart(9)} ${'limit'.padStart(9)}`);
for (const [name, shares] of [
  ['one buyer', [400_000n]],
  ['concentrated  600k/400k', [600_000n, 400_000n]],
  ['balanced  400k/300k/300k', [400_000n, 300_000n, 300_000n]],
]) {
  const { eligible, book, limit } = haircut(shares);
  const fmt = (v) => (v % BigInt(1_000_000) === 0n && v >= BigInt(1_000_000) ? `${(v / 1_000_000n).toString()}M` : `${(v / 1000n).toString()}k`);
  console.log(`  ${name.padEnd(22)} ${fmt(eligible).padStart(9)} ${fmt(book).padStart(9)} ${'-'.padStart(9)} ${fmt(limit).padStart(9)}`);
}

console.log('\n  key facts');
console.log('  • facilityLimit = 50% × (eligible − max(0, largest − 40% × eligible))');
console.log('  • a single-buyer operator books credit immediately (20% of revenue),');
console.log('    and the line grows to 50% as the portfolio diversifies');
console.log('  • every settlement auto-repays accrued debt before it adds revenue');

console.log(`\n${line}\n  Where next\n${line}\n`);
const envFile = resolve(root, '.env');
if (existsSync(envFile)) {
  const env = readFileSync(envFile, 'utf8');
  const vault = /COMPUTE_CRED_VAULT_CONTRACT_ADDRESS\s*=\s*(\S+)/.exec(env)?.[1];
  const witness = /PROOF_BUILDER_URL\s*=\s*(\S+)/.exec(env)?.[1];
  if (vault && witness && process.env.NODE_ENV !== 'test') {
    console.log('  Live deployment detected — run the proof pipeline:');
    console.log(
      `   1. npm run worker:start        # watch JobSettled → generate proofs → verifyAndRegister`
    );
    console.log('      (or npm run worker:prove -- --tx <0xhash> for a one-shot submission)');
    console.log('   2. npm run web:dev         # dashboard at http://localhost:5173');
    console.log('      vault address preset from .env; connect a wallet to draw/repay\n');
  } else {
    console.log('  .env present but not fully configured — see docs/ATTESTCOIN_INTEGRATION.md\n');
  }
} else {
  console.log('  No .env yet — copy .env.example → .env, then:');
  console.log('   1. deploy JobMarket (Sepolia), TestUSDC + ComputeCredVault (CC3 testnet)');
  console.log('   2. npm run worker:start     # proof pipeline (needs live CC3)');
  console.log('   3. npm run web:dev          # dashboard: http://localhost:5173');
  console.log('  Full live walkthrough: docs/ATTESTCOIN_INTEGRATION.md\n');
}

console.log(`${line}\n`);