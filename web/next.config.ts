import type { NextConfig } from "next";
const config: NextConfig = {
  transpilePackages: ["@tifo/core"],
  outputFileTracingIncludes: { "/p/[address]/opengraph-image": ["./assets/**"] },
};
export default config;
