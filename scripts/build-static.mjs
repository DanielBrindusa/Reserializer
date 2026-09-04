import { cpSync, existsSync, rmSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const scriptDir = dirname(fileURLToPath(import.meta.url));
const projectDir = resolve(scriptDir, '..');
const vinextCli = resolve(projectDir, 'node_modules/vinext/dist/cli.js');
const repositoryName = process.env.GITHUB_REPOSITORY?.split('/')[1] ?? '';
const isGithubPages = process.env.GITHUB_PAGES === 'true';
const isUserOrOrgPagesSite = repositoryName.endsWith('.github.io');
const pagesBasePath =
  isGithubPages && repositoryName && !isUserOrOrgPagesSite
    ? `/${repositoryName}`
    : '';

rmSync(resolve(projectDir, 'dist'), { recursive: true, force: true });

const result = spawnSync(process.execPath, [vinextCli, 'build'], {
  cwd: projectDir,
  env: {
    ...process.env,
    NEXT_PUBLIC_SITE_BASE_PATH:
      process.env.NEXT_PUBLIC_SITE_BASE_PATH ?? pagesBasePath,
  },
  encoding: 'utf8',
  stdio: ['ignore', 'pipe', 'pipe'],
});
const output = `${result.stdout ?? ''}${result.stderr ?? ''}`;

if (result.stdout) {
  process.stdout.write(result.stdout);
}

if (result.stderr) {
  process.stderr.write(result.stderr);
}

if (pagesBasePath) {
  const prefixedAssetsDir = resolve(
    projectDir,
    'dist/client',
    repositoryName,
    '_next',
  );
  const rootAssetsDir = resolve(projectDir, 'dist/client/_next');

  if (existsSync(prefixedAssetsDir)) {
    rmSync(rootAssetsDir, { recursive: true, force: true });
    cpSync(prefixedAssetsDir, rootAssetsDir, { recursive: true });
  }
}

if (result.status === 0) {
  process.exit(0);
}

const hasStaticOutput =
  existsSync(resolve(projectDir, 'dist/client/index.html')) &&
  existsSync(resolve(projectDir, 'dist/client/.nojekyll')) &&
  (!pagesBasePath || existsSync(resolve(projectDir, 'dist/client/_next')));
const completedStaticExport =
  output.includes("output: 'export'") && output.includes('Build complete');
const windowsShutdownAssertion =
  process.platform === 'win32' && output.includes('Assertion failed');

if (hasStaticOutput && completedStaticExport && windowsShutdownAssertion) {
  console.warn(
    '[build] Static export completed; ignoring a Windows-only prerender shutdown assertion.',
  );
  process.exit(0);
}

process.exit(result.status ?? 1);
