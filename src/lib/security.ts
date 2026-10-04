/**
 * ============================================================================
 * SHARED SECURITY HELPERS (pure functions)
 * ----------------------------------------------------------------------------
 * Used by the Convex backend AND by scripts/test-security.ts so the exact
 * production logic is what gets tested. No framework imports, no secrets.
 * ============================================================================
 */

/**
 * Cryptographically secure reference generator (CSPRNG + rejection sampling —
 * no modulo bias). Produces the SAME alphabet and format as the legacy
 * Math.random implementation so existing UI patterns and historical
 * references stay consistent (ambiguous characters I/L/O/0/1 excluded).
 */
const REF_CHARS = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";

export function randRef(prefix: string, len = 6): string {
  const limit = 256 - (256 % REF_CHARS.length);
  let out = "";
  while (out.length < len) {
    const bytes = new Uint8Array(len);
    crypto.getRandomValues(bytes);
    for (const b of bytes) {
      if (b >= limit) continue; // rejection sampling keeps the distribution uniform
      out += REF_CHARS[b % REF_CHARS.length];
      if (out.length === len) break;
    }
  }
  return `${prefix}-${out}`;
}

/**
 * SHA-256 hash (hex) for high-entropy API keys (192-bit penr_live_ tokens).
 * Preimage resistance of a 192-bit random key makes a fast hash safe here;
 * keys are never stored or returned in plaintext after generation.
 */
export async function hashApiKey(key: string): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(key),
  );
  return [...new Uint8Array(digest)]
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

/**
 * SSRF guard for outbound requests: only a PUBLIC https endpoint on port 443.
 * Rejects credentials in the URL, non-default ports, localhost/.local hosts,
 * cloud-metadata hostnames, dotted-decimal IPs in private/reserved ranges
 * (loopback, RFC1918, link-local 169.254/16 incl. cloud metadata, CGNAT
 * 100.64/10, multicast/reserved 224+, 0/8), and all IPv6 literals.
 *
 * NOTE: hostname-based targets are still resolved by the HTTP client, so DNS
 * rebinding can only be fully stopped at the infrastructure layer (egress
 * proxy / allow-listed destinations). Callers must pair this with
 * `redirect: "error"` so a public host cannot 30x us into a private one.
 */
export function isSafePublicHttpsUrl(value: string): boolean {
  try {
    const url = new URL(value);
    const host = url.hostname.toLowerCase();
    if (
      url.protocol !== "https:" ||
      url.username ||
      url.password ||
      (url.port && url.port !== "443")
    ) {
      return false;
    }
    if (
      host === "localhost" ||
      host.endsWith(".localhost") ||
      host.endsWith(".local") ||
      host === "metadata.google.internal" ||
      host === "instance-data" ||
      host.endsWith(".")
    ) {
      return false;
    }
    if (host.includes(":")) return false; // all IPv6 literals
    const octets = host.split(".").map(Number);
    if (octets.length === 4 && octets.every((n) => Number.isInteger(n) && n >= 0 && n <= 255)) {
      const [a, b] = octets;
      if (
        a === 0 ||
        a === 10 ||
        a === 127 ||
        a >= 224 ||
        (a === 169 && b === 254) ||
        (a === 172 && b >= 16 && b <= 31) ||
        (a === 192 && b === 0) ||
        (a === 192 && b === 168) ||
        (a === 198 && (b === 18 || b === 19)) ||
        (a === 100 && b >= 64 && b <= 127)
      ) {
        return false;
      }
    } else if (!host.includes(".")) {
      return false; // bare single-label hostnames (intranet names)
    }
    return true;
  } catch {
    return false;
  }
}

/**
 * Read a response/request body with a hard byte cap so a hostile peer cannot
 * force unbounded memory use. Throws once the cap is exceeded (the stream is
 * cancelled first).
 */
export async function readCapped(
  body: ReadableStream<Uint8Array> | null,
  maxBytes: number,
): Promise<string> {
  if (!body) return "";
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value) {
        total += value.byteLength;
        if (total > maxBytes) {
          await reader.cancel().catch(() => undefined);
          throw new Error(`body exceeds ${maxBytes} byte limit`);
        }
        chunks.push(value);
      }
    }
  } finally {
    reader.releaseLock?.();
  }
  const merged = new Uint8Array(total);
  let offset = 0;
  for (const c of chunks) {
    merged.set(c, offset);
    offset += c.byteLength;
  }
  return new TextDecoder().decode(merged);
}
