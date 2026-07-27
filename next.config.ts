import type { NextConfig } from 'next';

const nextConfig: NextConfig = {
  typescript: {
    // Never silently ship type errors — Phase 0 AC #1.
    ignoreBuildErrors: false,
  },
  eslint: {
    ignoreDuringBuilds: false,
  },
  serverExternalPackages: ['postgres'],
};

export default nextConfig;
