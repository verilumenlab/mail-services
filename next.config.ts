import type { NextConfig } from "next";

const securityHeaders = [
  { key: "X-Frame-Options", value: "DENY" },
  { key: "X-Content-Type-Options", value: "nosniff" },
  { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
  { key: "Permissions-Policy", value: "camera=(), microphone=(), geolocation=()" },
];

const desktopBuild = process.env.NEXT_OUTPUT_STANDALONE === "1";

const nextConfig: NextConfig = {
  // The desktop build (scripts/desktop-prepare.mjs) runs the self-contained server.js from .next-desktop/standalone.
  output: desktopBuild ? "standalone" : undefined,
  distDir: desktopBuild ? ".next-desktop" : ".next",
  poweredByHeader: false,
  serverExternalPackages: ["pg", "@prisma/adapter-pg", "@prisma/client", "exceljs", "sharp", "node-forge", "@signpdf/signpdf", "@signpdf/signer-p12", "@signpdf/placeholder-pdf-lib", "@signpdf/utils"],
  experimental: {
    // The app proxy otherwise rejects request bodies over 10 MB. Campaign attachments allow 100 MB.
    proxyClientMaxBodySize: "100mb",
  },
  async headers() {
    return [
      { source: "/:path*", headers: securityHeaders },
      {
        // Signing links carry a secret token in the path; never leak it through Referer.
        source: "/sign/:path*",
        headers: [
          { key: "Referrer-Policy", value: "no-referrer" },
          { key: "X-Robots-Tag", value: "noindex, nofollow" },
        ],
      },
    ];
  },
};

export default nextConfig;
