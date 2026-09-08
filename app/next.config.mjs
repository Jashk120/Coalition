/** @type {import('next').NextConfig} */
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

const nextConfig = {
  reactStrictMode: true,
  transpilePackages: ['@jx-nexus/coalition'],
  outputFileTracingRoot: root,
};

export default nextConfig;
