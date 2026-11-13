import type {NextConfig} from 'next';

const nextConfig: NextConfig = {
  reactStrictMode: true,
  typescript: {
    ignoreBuildErrors: false,
  },
  // Allow access to remote image placeholder.
  images: {
    remotePatterns: [
      {
        protocol: 'https',
        hostname: 'picsum.photos',
        port: '',
        pathname: '/**', // This allows any path under the hostname
      },
    ],
  },
  output: 'standalone',
  transpilePackages: ['motion'],
  // Pin the root: otherwise Next picks the outermost lockfile it finds (e.g. a stray
  // ~/package-lock.json) and Turbopack scans the whole home directory, exhausting memory.
  turbopack: {root: __dirname},
  webpack: (config, {dev}) => {
    // Opt-in for local development: DISABLE_HMR=true turns off webpack file
    // watching in `next dev` (no hot reload while files are edited in bulk).
    if (dev && process.env.DISABLE_HMR === 'true') {
      config.watchOptions = {
        ignored: /.*/,
      };
    }
    return config;
  },
};

export default nextConfig;
