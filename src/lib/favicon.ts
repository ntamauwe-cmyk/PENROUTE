/**
 * Favicon: the static /logo.svg is the approved symbol-only Penroute mark.
 * The PWA manifest icon points at the same symbol mark. Nothing dynamic needed;
 * kept as a no-op hook so the app entry wiring stays stable.
 */
export function adoptMasterFavicon(): void {
  /* favicon is the static symbol-only /logo.svg — no runtime swap required */
}
