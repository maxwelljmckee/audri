// Learn more https://docs.expo.dev/guides/customizing-metro
// + monorepo per https://docs.expo.dev/guides/monorepos/
// + NativeWind v5 per nativewind/metro
const { getDefaultConfig } = require('expo/metro-config');
const { withNativeWind } = require('nativewind/metro');
const path = require('node:path');

const projectRoot = __dirname;
const monorepoRoot = path.resolve(projectRoot, '../..');

const config = getDefaultConfig(projectRoot);

// Monorepo: watch + resolve from workspace root
config.watchFolders = [monorepoRoot];
config.resolver.nodeModulesPaths = [
  path.resolve(projectRoot, 'node_modules'),
  path.resolve(monorepoRoot, 'node_modules'),
];
config.resolver.disableHierarchicalLookup = true;

// Worker-only deps that pnpm hoists to the monorepo root. They reference
// Node-only globals (e.g. SharedArrayBuffer in jsdom's transitive tree),
// which Hermes doesn't expose — so a stray require chain into one of these
// blows up the mobile bundle with "Property 'SharedArrayBuffer' doesn't
// exist." Patterns cover BOTH the hoisted symlink path and pnpm's internal
// store path. Add new worker-only packages to this list as they land.
const WORKER_ONLY_PACKAGES = [
  'jsdom',
  '@mozilla/readability',
  'pdf-parse',
  'mammoth',
  'undici',
];
config.resolver.blockList = WORKER_ONLY_PACKAGES.flatMap((pkg) => {
  const escaped = pkg.replace(/[/]/g, '\\/').replace(/[.]/g, '\\.');
  return [
    new RegExp(`/node_modules/${escaped}/.*`),
    new RegExp(`/\\.pnpm/${escaped}@[^/]+/.*`),
  ];
});

// NativeWind v5 needs package-exports + browser conditions
config.resolver.unstable_enablePackageExports = true;
config.resolver.unstable_conditionNames = ['browser', 'default'];

module.exports = withNativeWind(config, {
  input: './global.css',
  typescriptEnvPath: './nativewind-env.d.ts',
});
