import type { NextConfig } from 'next';

const repositoryName = process.env.GITHUB_REPOSITORY?.split('/')[1] ?? '';
const isGithubPages = process.env.GITHUB_PAGES === 'true';
const isUserOrOrgPagesSite = repositoryName.endsWith('.github.io');
const pagesAssetPrefix =
  isGithubPages && repositoryName && !isUserOrOrgPagesSite
    ? `/${repositoryName}`
    : '';

const nextConfig: NextConfig = {
  output: 'export',
  trailingSlash: true,
  images: {
    unoptimized: true,
  },
  ...(pagesAssetPrefix
    ? {
        assetPrefix: pagesAssetPrefix,
      }
    : {}),
};

export default nextConfig;
