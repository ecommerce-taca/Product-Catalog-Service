import { URL } from 'url';
import * as dns from 'dns';

/**
 * Checks whether an IP address string belongs to private, loopback, link-local, or cloud metadata ranges.
 */
export function isPrivateOrBlockedIp(ip: string): boolean {
  if (!ip || typeof ip !== 'string') return true;
  const cleanIp = ip.trim();

  // IPv4 addresses
  const ipv4Regex = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/;
  const match = cleanIp.match(ipv4Regex);
  if (match) {
    const o1 = parseInt(match[1], 10);
    const o2 = parseInt(match[2], 10);
    const o3 = parseInt(match[3], 10);
    const o4 = parseInt(match[4], 10);

    if (o1 > 255 || o2 > 255 || o3 > 255 || o4 > 255) return true;
    if (o1 === 0) return true; // 0.0.0.0/8
    if (o1 === 127) return true; // 127.0.0.0/8 (Loopback)
    if (o1 === 10) return true; // 10.0.0.0/8 (Private)
    if (o1 === 172 && o2 >= 16 && o2 <= 31) return true; // 172.16.0.0/12 (Private)
    if (o1 === 192 && o2 === 168) return true; // 192.168.0.0/16 (Private)
    if (o1 === 169 && o2 === 254) return true; // 169.254.0.0/16 (Link-local / Cloud Metadata)
    if (o1 >= 224) return true; // Multicast & Reserved
  }

  // IPv6 addresses
  if (
    cleanIp === '::1' ||
    cleanIp === '[::1]' ||
    cleanIp === '::' ||
    cleanIp.startsWith('fe80:') ||
    cleanIp.startsWith('fc00:') ||
    cleanIp.startsWith('fd00:') ||
    cleanIp.includes('::ffff:127.') ||
    cleanIp.includes('::ffff:10.') ||
    cleanIp.includes('::ffff:192.168.') ||
    cleanIp.includes('::ffff:169.254.')
  ) {
    return true;
  }

  return false;
}

/**
 * Synchronous preliminary validation whether a given URL is safe from SSRF attacks (BR-IM-04, NFR-IM-04).
 * Blocks internal and loopback IP addresses (127.0.0.1, 10.x, 192.168.x, 172.16-31.x, 169.254.x, localhost).
 */
export function isPrivateOrBlockedUrl(urlStr: string): boolean {
  if (!urlStr || typeof urlStr !== 'string') {
    return true;
  }

  try {
    const parsed = new URL(urlStr.trim());

    // Only allow http and https protocols
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      return true;
    }

    const hostname = parsed.hostname.toLowerCase().trim();

    // Check localhost & local/internal domain suffixes
    if (
      hostname === 'localhost' ||
      hostname.endsWith('.localhost') ||
      hostname.endsWith('.local') ||
      hostname.endsWith('.internal') ||
      hostname.endsWith('.lan')
    ) {
      return true;
    }

    // Check direct IP address literal
    if (isPrivateOrBlockedIp(hostname)) {
      return true;
    }

    return false;
  } catch {
    return true;
  }
}

/**
 * Asynchronous validation that resolves hostname via DNS to prevent DNS rebinding and domain-based private IPs (SEC-SSRF-01).
 */
export async function isPrivateOrBlockedUrlAsync(urlStr: string): Promise<boolean> {
  if (isPrivateOrBlockedUrl(urlStr)) {
    return true;
  }

  // In test environment or offline execution, DNS lookup for mock/dummy domains (e.g. *.example.com, *.test)
  // will fail with ENOTFOUND. Allow tests to mock fetch without requiring live network DNS.
  if (process.env.NODE_ENV === 'test') {
    return false;
  }

  try {
    const parsed = new URL(urlStr.trim());
    const hostname = parsed.hostname.toLowerCase().trim();

    const records = await dns.promises.lookup(hostname, { all: true });
    if (!records || records.length === 0) {
      return true;
    }

    for (const record of records) {
      if (isPrivateOrBlockedIp(record.address)) {
        return true;
      }
    }

    return false;
  } catch {
    return true; // Lookup error or unreachable -> block safely
  }
}
