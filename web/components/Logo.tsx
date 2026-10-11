// The Tifo mark and wordmark. The mark is the same shape as the app icon.
export function Mark({ size = 26 }: { size?: number }) {
  return (
    <svg className="mark" width={size} height={size} viewBox="0 0 512 512" aria-hidden>
      <rect width="512" height="512" rx="136" fill="var(--accent)" />
      <circle cx="150" cy="150" r="46" fill="#111114" />
      <path fill="#111114" d="M214 196h56v-58h74v58h66v62h-66v92c0 22 10 32 32 32h34v64h-52c-60 0-88-28-88-88V258h-56z" />
    </svg>
  );
}

export default function Logo({ size }: { size?: number }) {
  return (
    <a href="/" className="brand" aria-label="Tifo home">
      <Mark size={size} />
      tifo
    </a>
  );
}
