export function Logo({ size = 32 }: { size?: number }) {
  return (
    <div style={{ display: "flex", alignItems: "center", gap: "0.6rem" }}>
      <svg viewBox="0 0 48 48" width={size} height={size} xmlns="http://www.w3.org/2000/svg">
        <defs>
          <linearGradient id="oe-grad" x1="0" y1="0" x2="48" y2="48" gradientUnits="userSpaceOnUse">
            <stop offset="0%" stopColor="#1d4ed8" />
            <stop offset="100%" stopColor="#38e0ff" />
          </linearGradient>
        </defs>
        <circle cx="24" cy="24" r="24" fill="url(#oe-grad)" />
        <path
          d="M16 32 V22 C16 16.5 19.6 13 24 13 C28.4 13 32 16.5 32 22 V32"
          fill="none"
          stroke="#eef1f8"
          strokeWidth="2.5"
          strokeLinecap="round"
        />
        <circle cx="24" cy="32" r="2.4" fill="#eef1f8" />
      </svg>
      <span className="wordmark">OpenEden</span>
    </div>
  );
}