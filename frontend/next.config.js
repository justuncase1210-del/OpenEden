/** @type {import('next').NextConfig} */
const isProd = process.env.NODE_ENV === "production";
const backend = process.env.NEXT_PUBLIC_BACKEND_URL || "http://localhost:4022";

// Minter-controlled image URLs mean img-src must allow any https host, so the
// protection here is everything else: no framing, no plugins, no foreign
// scripts/forms, and images are fetched with no Referer (see imageSrc usage).
const csp = [
  "default-src 'self'",
  "base-uri 'self'",
  "object-src 'none'",
  "frame-ancestors 'none'",
  "form-action 'self'",
  `script-src 'self' 'unsafe-inline'${isProd ? "" : " 'unsafe-eval'"}`,
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' https: data:",
  "font-src 'self' data:",
  `connect-src 'self' ${backend}`,
].join("; ");

module.exports = {
  poweredByHeader: false,
  async headers() {
    return [
      {
        source: "/:path*",
        headers: [
          ...(isProd ? [{ key: "Content-Security-Policy", value: csp }] : []),
          { key: "X-Content-Type-Options", value: "nosniff" },
          { key: "X-Frame-Options", value: "DENY" },
          { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
          { key: "Permissions-Policy", value: "camera=(), microphone=(), geolocation=()" },
        ],
      },
    ];
  },
};
