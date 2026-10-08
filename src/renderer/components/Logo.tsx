export function Logo({ size = 22 }: { size?: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 32 32"
      fill="none"
      style={{ display: 'block', flexShrink: 0 }}
    >
      <defs>
        <linearGradient id="kineticut-grad" x1="0" y1="0" x2="32" y2="32">
          <stop stopColor="#6d8dff" />
          <stop offset="1" stopColor="#9a7bff" />
        </linearGradient>
      </defs>
      <rect width="32" height="32" rx="8" fill="url(#kineticut-grad)" />
      <path d="M18.6 4.5 8.8 18h6.1l-1.6 9.5L23.2 14h-6.1l1.5-9.5z" fill="#fff" />
    </svg>
  )
}
