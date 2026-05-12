#!/usr/bin/env node
// Single-shot version bump. Reads desired target from argv, writes to:
//   - root `package.json` (the product-semver source of truth)
//   - `apps/mobile/app.json` (`expo.version`)
//
// Does NOT touch:
//   - Sub-package package.json files (`apps/*/package.json` etc.) — they're
//     pinned at "0.0.0" since they're private workspace packages, never
//     published. Bumping them would create churn for no reason.
//   - `apps/mobile/app.json` `expo.ios.buildNumber` — orthogonal concept,
//     auto-incremented by EAS Build via `autoIncrement: true` in eas.json.
//   - EAS Build's remote app version — EAS holds its own value because
//     `appVersionSource: "remote"` is set in eas.json. Sync with
//     `eas build:version:set --platform ios --value <semver>` when needed.
//
// Usage:
//   node scripts/bump-version.mjs 0.3.0
//   pnpm version:bump 0.3.0

import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(__dirname, '..');

function fail(msg) {
  console.error(`[bump-version] error: ${msg}`);
  process.exit(1);
}

// Validate semver-ish: M.m.p with optional -prerelease tail.
const SEMVER = /^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/;

const target = process.argv[2];
if (!target) {
  fail('missing target version. usage: pnpm version:bump <semver>');
}
if (!SEMVER.test(target)) {
  fail(`'${target}' is not a valid semver. expected M.m.p or M.m.p-prerelease`);
}

// Helper: write JSON preserving 2-space indentation + trailing newline.
function readJson(path) {
  return JSON.parse(readFileSync(path, 'utf8'));
}
function writeJson(path, data) {
  writeFileSync(path, `${JSON.stringify(data, null, 2)}\n`);
}

const targets = [
  {
    path: join(repoRoot, 'package.json'),
    label: 'root package.json',
    read: (j) => j.version,
    write: (j) => {
      j.version = target;
    },
  },
  {
    path: join(repoRoot, 'apps/mobile/app.json'),
    label: 'apps/mobile/app.json (expo.version)',
    read: (j) => j.expo?.version,
    write: (j) => {
      if (!j.expo) fail('apps/mobile/app.json has no `expo` block — unexpected shape');
      j.expo.version = target;
    },
  },
];

const updates = [];
for (const t of targets) {
  const before = readJson(t.path);
  const current = t.read(before);
  if (current === target) {
    updates.push({ label: t.label, status: 'unchanged', from: current, to: target });
    continue;
  }
  t.write(before);
  writeJson(t.path, before);
  updates.push({ label: t.label, status: 'updated', from: current, to: target });
}

console.log(`\n[bump-version] target: ${target}\n`);
for (const u of updates) {
  if (u.status === 'unchanged') {
    console.log(`  ✓  ${u.label} — already at ${u.to}`);
  } else {
    console.log(`  ↑  ${u.label} — ${u.from} → ${u.to}`);
  }
}

console.log('\nNext steps:');
console.log(`  • Commit the version bump: git add -A && git commit -m "chore: bump version to ${target}"`);
console.log('  • For TestFlight: EAS remotely manages app version (appVersionSource: "remote").');
console.log(`    Sync EAS remote: eas build:version:set --platform ios --value ${target}`);
console.log('    (skip if you want EAS auto-increment to keep handling it.)');
console.log('  • iOS buildNumber auto-increments on every EAS Build — no manual step needed.\n');
