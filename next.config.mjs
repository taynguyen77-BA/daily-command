/** @type {import('next').NextConfig} */
const nextConfig = {
  // Dev speed: Turbopack keeps its compile cache on disk, so restarting `npm run dev` does not recompile every route again.
  experimental: { turbopackFileSystemCacheForDev: true },
};

export default nextConfig;
