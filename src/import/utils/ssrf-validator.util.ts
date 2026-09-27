import { URL } from 'url';

/**
 * Validates whether a given URL is safe from SSRF attacks (BR-IM-04, NFR-IM-04).
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

    // Check IPv4 addresses
    const ipv4Regex = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/;
    const match = hostname.match(ipv4Regex);
    if (match) {
      const o1 = parseInt(match[1], 10);
      const o2 = parseInt(match[2], 10);
      const o3 = parseInt(match[3], 10);
      const o4 = parseInt(match[4], 10);

      if (o1 > 255 || o2 > 255 || o3 > 255 || o4 > 255) {
        return true;
      }

      // 0.0.0.0/8 (Broadcast/Current network)
      if (o1 === 0) return true;

      // 127.0.0.0/8 (Loopback)
      if (o1 === 127) return true;

      // 10.0.0.0/8 (Private RFC 1918)
      if (o1 === 10) return true;

      // 172.16.0.0/12 (Private RFC 1918: 172.16.x.x - 172.31.x.x)
      if (o1 === 172 && o2 >= 16 && o2 <= 31) return true;

      // 192.168.0.0/16 (Private RFC 1918)
      if (o1 === 192 && o2 === 168) return true;

      // 169.254.0.0/16 (Link-local / AWS / GCP Cloud Metadata endpoint)
      if (o1 === 169 && o2 === 254) return true;

      // 224.0.0.0/4 (Multicast) & 240.0.0.0/4 (Reserved)
      if (o1 >= 224) return true;
    }

    // Check IPv6 addresses
    if (
      hostname === '::1' ||
      hostname === '[::1]' ||
      hostname === '::' ||
      hostname.startsWith('fe80:') ||
      hostname.startsWith('fc00:') ||
      hostname.startsWith('fd00:') ||
      hostname.includes('::ffff:127.') ||
      hostname.includes('::ffff:10.') ||
      hostname.includes('::ffff:192.168.')
    ) {
      return true;
    }

    return false;
  } catch {
    return true;
  }
}
