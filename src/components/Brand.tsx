/**
 * Penroute brand assets — converted from the APPROVED master logo.
 * The mark preserves the master's exact construction: thick green gradient P,
 * straight stem with angled foot, bowl with an open notch at the lower-left,
 * and the lighter route arrow rising through the notch with a chevron head.
 * The wordmark and tagline use Montserrat, matching the master lockup
 * proportions. Do not modify the geometry or colours of the mark.
 */

export function PenrouteSymbol({ className = "size-9" }: { className?: string }) {
  return (
    <svg viewBox="0 0 96 96" fill="none" className={className} aria-hidden="true">
      <defs>
        <linearGradient id="pen-p-grad" x1="20" y1="82" x2="72" y2="12" gradientUnits="userSpaceOnUse">
          <stop offset="0" stopColor="#0C9A62" />
          <stop offset="1" stopColor="#00E0A0" />
        </linearGradient>
        <linearGradient id="pen-arrow-grad" x1="26" y1="66" x2="56" y2="24" gradientUnits="userSpaceOnUse">
          <stop offset="0" stopColor="#5FCE9E" />
          <stop offset="1" stopColor="#9FE8CF" />
        </linearGradient>
      </defs>
      {/* Stem with angled foot */}
      <path
        d="M34 26 L34 56 L21 72"
        stroke="url(#pen-p-grad)"
        strokeWidth="13"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      {/* Bowl with open notch at the lower-left */}
      <path
        d="M34 26 C44 14, 68 16, 72 32 C76 48, 60 58, 46 53"
        stroke="url(#pen-p-grad)"
        strokeWidth="13"
        strokeLinecap="round"
      />
      {/* Route arrow rising through the notch */}
      <path
        d="M30 64 L47 33"
        stroke="url(#pen-arrow-grad)"
        strokeWidth="9"
        strokeLinecap="round"
      />
      {/* Chevron arrowhead */}
      <path
        d="M38 34 L48 31 L47 42"
        stroke="url(#pen-arrow-grad)"
        strokeWidth="9"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

/**
 * Full horizontal logo lockup: symbol + wordmark (+ optional tagline),
 * matching the approved master proportions.
 */
export function Logo({
  onDark = false,
  size = "md",
  tagline = false,
}: {
  onDark?: boolean;
  size?: "sm" | "md" | "lg";
  tagline?: boolean;
}) {
  const dim = size === "lg" ? "size-11 sm:size-12" : size === "sm" ? "size-8" : "size-9";
  const word = size === "lg" ? "text-2xl sm:text-[1.7rem]" : size === "sm" ? "text-lg" : "text-xl";
  const wordColor = onDark ? "#FFFFFF" : "#0B1F2A";
  const tagColor = onDark ? "rgba(255,255,255,0.78)" : "#0B1F2A";

  return (
    <span className="inline-flex items-center gap-2.5">
      <PenrouteSymbol className={dim} />
      <span className="leading-none">
        <span
          className={`block font-extrabold tracking-[-0.02em] ${word}`}
          style={{ color: wordColor }}
        >
          Penroute
        </span>
        {tagline && (
          <span
            className="mt-1.5 block text-[0.55rem] font-semibold uppercase tracking-[0.28em]"
            style={{ color: tagColor }}
          >
            Pension Payments. Simplified.
          </span>
        )}
      </span>
    </span>
  );
}

/** Subtle flowing route lines for navy sections — inspired by the mark's route arrow. */
export function RouteLines({ className = "" }: { className?: string }) {
  return (
    <svg
      viewBox="0 0 600 400"
      preserveAspectRatio="none"
      aria-hidden="true"
      className={`pointer-events-none absolute inset-0 h-full w-full ${className}`}
    >
      <path
        d="M-40 340 C 140 300, 220 180, 380 160 S 560 90, 640 40"
        fill="none"
        stroke="#00C896"
        strokeOpacity="0.14"
        strokeWidth="2.5"
      />
      <path
        d="M-40 380 C 160 340, 260 220, 420 200 S 580 140, 660 90"
        fill="none"
        stroke="#D4AF37"
        strokeOpacity="0.08"
        strokeWidth="2"
      />
      <path
        d="M-40 300 C 120 260, 200 140, 350 120 S 540 50, 620 -10"
        fill="none"
        stroke="#00C896"
        strokeOpacity="0.07"
        strokeWidth="1.5"
      />
    </svg>
  );
}
