/** Turn a Convex/network error into a message fit to show a user.
 *  ConvexError data is shown as-is (it survives production redaction); plain
 *  errors are stripped of Convex's request/stack framing. */
export function friendlyError(e: unknown, fallback = "Something went wrong — please try again"): string {
  if (e && typeof e === "object" && "data" in e && typeof (e as { data: unknown }).data === "string") {
    return (e as { data: string }).data;
  }
  if (!(e instanceof Error) || !e.message) return fallback;
  const m = e.message;
  const uncaught = m.match(/Uncaught (?:Convex)?Error: ([^\n]+)/);
  const text = (uncaught ? uncaught[1] : m)
    .replace(/^\[CONVEX [^\]]*\]\s*/, "")
    .replace(/\[Request ID: [^\]]*\]\s*/, "")
    .replace(/\s+at .*$/s, "")
    .replace(/\s*Called by client$/, "")
    .trim();
  if (!text || /^Server Error$/i.test(text)) return fallback;
  return text;
}
