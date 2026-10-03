/**
 * Penroute brand assets — exact artwork extracted from the approved master brand board.
 * Use the supplied SVG artwork rather than recreating the mark in CSS or inline paths.
 */
export function PenrouteSymbol({ className = "size-9" }: { className?: string }) {
  return (
    <img
      src="/brand/penroute-mark-traced.svg"
      className={className}
      alt=""
      aria-hidden="true"
    />
  );
}

export function Logo({
  onDark = false,
  size = "md",
  tagline = false,
}: {
  onDark?: boolean;
  size?: "sm" | "md" | "lg";
  tagline?: boolean;
}) {
  const width = size === "lg" ? "w-[190px] sm:w-[225px]" : size === "sm" ? "w-[145px]" : "w-[175px]";
  return (
    <img
      src={onDark ? "/brand/penroute-logo-traced.svg" : "/brand/penroute-logo-light.svg"}
      className={`block h-auto object-contain ${width}`}
      alt={tagline ? "Penroute — Pension Payments. Simplified." : "Penroute"}
    />
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
