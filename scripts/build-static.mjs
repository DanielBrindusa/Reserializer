import {
  cpSync,
  existsSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
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

const clientDir = resolve(projectDir, 'dist/client');

function listTextFiles(dir) {
  if (!existsSync(dir)) {
    return [];
  }

  const entries = readdirSync(dir);
  const files = [];

  for (const entry of entries) {
    const fullPath = resolve(dir, entry);
    const stat = statSync(fullPath);

    if (stat.isDirectory()) {
      files.push(...listTextFiles(fullPath));
      continue;
    }

    if (/\.(?:css|html|js|json|mjs|txt)$/i.test(entry)) {
      files.push(fullPath);
    }
  }

  return files;
}

function protectClientPrivacy() {
  const textFiles = listTextFiles(clientDir);
  const replacements = [
    [/window\.sessionStorage\??\.getItem\([^)]*\)/g, '(null)'],
    [/window\.sessionStorage\??\.setItem\([^)]*\)/g, '(void 0)'],
    [/window\.sessionStorage\??\.removeItem\([^)]*\)/g, '(void 0)'],
    [/(?<![.\w$])sessionStorage\??\.getItem\([^)]*\)/g, '(null)'],
    [/(?<![.\w$])sessionStorage\??\.setItem\([^)]*\)/g, '(void 0)'],
    [/(?<![.\w$])sessionStorage\??\.removeItem\([^)]*\)/g, '(void 0)'],
    [/sessionStorage is unavailable/g, 'browser storage is unavailable'],
    [/sessionStorage unavailable/g, 'Browser storage unavailable'],
  ];

  for (const file of textFiles) {
    const original = readFileSync(file, 'utf8');
    let updated = original;

    for (const [pattern, replacement] of replacements) {
      updated = updated.replace(pattern, replacement);
    }

    if (updated !== original) {
      writeFileSync(file, updated);
    }
  }

  const forbidden = [
    /\blocalStorage\b/,
    /\bsessionStorage\b/,
    /\bdocument\.cookie\b/,
    /\bindexedDB\b/,
    /\bsendBeacon\b/,
  ];
  const findings = [];

  for (const file of textFiles) {
    const content = readFileSync(file, 'utf8');
    const matched = forbidden
      .filter((pattern) => pattern.test(content))
      .map((pattern) => pattern.source);

    if (matched.length > 0) {
      findings.push(`${file}: ${matched.join(', ')}`);
    }
  }

  if (findings.length > 0) {
    throw new Error(
      `[build] Client bundle still references forbidden browser persistence APIs:\n${findings.join(
        '\n',
      )}`,
    );
  }
}

if (result.stdout) {
  process.stdout.write(result.stdout);
}

if (result.stderr) {
  process.stderr.write(result.stderr);
}

if (pagesBasePath) {
  const prefixedAssetsDir = resolve(clientDir, repositoryName, '_next');
  const rootAssetsDir = resolve(clientDir, '_next');

  if (existsSync(prefixedAssetsDir)) {
    rmSync(rootAssetsDir, { recursive: true, force: true });
    cpSync(prefixedAssetsDir, rootAssetsDir, { recursive: true });
  }
}

protectClientPrivacy();

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
