// ComputeCred build report — generated during the Release workflow.
// Prints a compact summary of the artifact, ref and dependency graph.
import { readFileSync } from 'node:fs';

try {
  const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
  const depShr = (name) => {
    try {
      const d = JSON.parse(readFileSync(new URL(`../${name}/package.json`, import.meta.url), 'utf8'));
      return `${name}@${d.version}`;
    } catch {
      return name;
    }
  };
  console.log(`ComputeCred ${process.env.GITHUB_SHA ?? 'local'}`);
  console.log(`root: ${pkg.name}@${pkg.version}`);
  console.log(`workspaces: ${['contracts', 'worker', 'web'].map(depShr).join('  ')}`);
  console.log('bundle: web/dist (Playwright-loadable SPA, CC3 testnet)');
} catch (e) {
  console.error(`build report failed: ${e.message}`);
  process.exit(1);
}