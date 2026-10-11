/**
 * Shared URL validation for SSRF prevention.
 * Blocks metadata endpoints and private/internal IP ranges.
 */

/** Blocked hostnames for SSRF prevention (cloud metadata endpoints) */
const BLOCKED_HOSTS = [
  '169.254.169.254',
  'metadata.google.internal',
  'metadata.internal',
  '100.100.100.200',
  'metadata.cloud.google.internal',
];

/** Check if an IP address is in a private/internal range */
function isPrivateIP(hostname: string): boolean {
  // IPv4 private ranges
  const ipv4Patterns = [
    /^10\.\d+\.\d+\.\d+$/,           // 10.0.0.0/8
    /^172\.(1[6-9]|2\d|3[01])\.\d+\.\d+$/, // 172.16.0.0/12
    /^192\.168\.\d+\.\d+$/,            // 192.168.0.0/16
    /^127\.\d+\.\d+\.\d+$/,            // 127.0.0.0/8 (loopback)
    /^0\.0\.0\.0$/,                    // 0.0.0.0
    /^169\.254\.\d+\.\d+$/,            // 169.254.0.0/16 (link-local)
  ];
  if (ipv4Patterns.some(p => p.test(hostname))) return true;

  // IPv6 private/loopback
  if (hostname === '::1' || hostname === '[::1]') return true;
  if (/^\[?fe80:/i.test(hostname)) return true; // link-local
  if (/^\[?fc00:/i.test(hostname) || /^\[?fd00:/i.test(hostname)) return true; // unique local

  return false;
}

export interface UrlValidationResult {
  url: URL;
  safe: boolean;
  reason?: string;
}

export interface UrlValidationOptions {
  /** Allow private IPs (e.g., for local model endpoints). Default false. */
  allowPrivate?: boolean;
  /** Additional allowed hostnames (e.g., localhost for dev). */
  allowedHosts?: string[];
  /** URL prefixes that are always allowed (skip all other checks). */
  allowedPrefixes?: string[];
}

/**
 * Validate a URL for SSRF safety.
 * - Blocks non-HTTP protocols
 * - Blocks cloud metadata endpoints
 * - Blocks private/internal IPs (unless allowPrivate is true)
 * - Returns parsed URL and safe status
 */
export function validateScanUrl(
  url: string,
  options: UrlValidationOptions = {},
): UrlValidationResult {
  try {
    const parsed = new URL(url);

    // Only allow HTTP/HTTPS
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      return {
        url: parsed,
        safe: false,
        reason: `Unsafe protocol: ${parsed.protocol}`,
      };
    }

    // Check allowed prefixes first (skip all other checks)
    if (options.allowedPrefixes?.length) {
      if (options.allowedPrefixes.some(p => url.startsWith(p))) {
        return { url: parsed, safe: true };
      }
      // If prefixes are specified and URL doesn't match, block it
      return {
        url: parsed,
        safe: false,
        reason: `URL not in allowlist: ${url}`,
      };
    }

    // Check allowed hosts
    if (options.allowedHosts?.length) {
      if (options.allowedHosts.includes(parsed.hostname)) {
        return { url: parsed, safe: true };
      }
    }

    // Block cloud metadata endpoints
    if (BLOCKED_HOSTS.some(b => parsed.hostname === b || parsed.hostname.endsWith('.' + b))) {
      return {
        url: parsed,
        safe: false,
        reason: `Blocked metadata endpoint: ${parsed.hostname}`,
      };
    }

    // Block private IPs unless explicitly allowed
    if (!options.allowPrivate && isPrivateIP(parsed.hostname)) {
      return {
        url: parsed,
        safe: false,
        reason: `Blocked private/internal IP: ${parsed.hostname}`,
      };
    }

    return { url: parsed, safe: true };
  } catch {
    return {
      url: new URL('about:blank'),
      safe: false,
      reason: `Invalid URL: ${url}`,
    };
  }
}

/**
 * Simple validate function that returns URL or null.
 * For use in existing code that expects URL | null.
 */
export function validateUrl(url: string, options?: UrlValidationOptions): URL | null {
  const result = validateScanUrl(url, options);
  return result.safe ? result.url : null;
}

/**
 * Assert a URL is safe, throwing if not.
 * For use in code that expects to throw on unsafe URLs.
 */
export function assertSafeUrl(url: string, options?: UrlValidationOptions): void {
  const result = validateScanUrl(url, options);
  if (!result.safe) {
    throw new Error(result.reason || 'Unsafe URL');
  }
}

export { isPrivateIP, BLOCKED_HOSTS };
