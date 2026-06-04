import { createMDX } from 'fumadocs-mdx/next';

const withMDX = createMDX();

// GitHub Pages serves project sites under /<repo>, so the Pages workflow sets
// NEXT_BASE_PATH=/nestjs-telescope. Local dev/build stays at the root.
const basePath = process.env.NEXT_BASE_PATH ?? '';

/** @type {import('next').NextConfig} */
const config = {
  output: 'export',
  reactStrictMode: true,
  basePath,
};

export default withMDX(config);
