/**
 * Image input helpers — convert OpenAI `image_url` content parts into
 * Gemini/Antigravity-native `inlineData` parts.
 *
 * Hardening rules (aligned with the VISION_SUPPORT_PLAN):
 *  - Gemini's inline-data ceiling is 20MB for the whole request (base64 included).
 *    Keep binary well below that to leave headroom for text/tools/thinking.
 *  - Remote fetch has a timeout, a size cap, an MIME allow-list and an SSRF
 *    guard (loopback / link-local / private ranges blocked by default).
 *  - Any failure degrades to a visible text placeholder, never a thrown error,
 *    so a single bad image can never break a whole conversation.
 *  - Logs never contain base64 payloads.
 */

import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';
import { createLogger } from './logger.js';

const log = createLogger('image-input');

/** Single image binary size cap (Gemini inline ceiling is 20MB total). */
export const MAX_IMAGE_BYTES = 8 * 1024 * 1024;
/** Total binary budget for all images in a single request. */
export const MAX_TOTAL_IMAGE_BYTES = 15 * 1024 * 1024;

/** Remote image fetch timeout. */
export const IMAGE_FETCH_TIMEOUT_MS = 15_000;
const MAX_REDIRECTS = 3;

export const ALLOWED_MIMES: ReadonlySet<string> = new Set([
  'image/png',
  'image/jpeg',
  'image/webp',
  'image/heic',
  'image/heif',
]);

export interface InlineData {
  mimeType: string;
  data: string;
}

export interface ImageBudget {
  remainingBytes: number;
}

export type ImageResolution = { inlineData: InlineData } | { omitted: string };

/** Creates a fresh per-request image byte budget. */
export function createImageBudget(): ImageBudget {
  return { remainingBytes: MAX_TOTAL_IMAGE_BYTES };
}

function allowPrivateHosts(): boolean {
  return process.env.IMAGE_FETCH_ALLOW_PRIVATE === 'true';
}

/**
 * Sniffs the MIME type from magic bytes. Returns `null` when the payload is
 * not a recognised image. `Content-Type` from the wire is only a fallback.
 */
export function sniffImageMime(buf: Buffer): string | null {
  if (buf.length >= 8) {
    // PNG: 89 50 4E 47 0D 0A 1A 0A
    if (
      buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47 &&
      buf[4] === 0x0d && buf[5] === 0x0a && buf[6] === 0x1a && buf[7] === 0x0a
    ) {
      return 'image/png';
    }
    // JPEG: FF D8 FF
    if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) {
      return 'image/jpeg';
    }
  }

  if (buf.length >= 12) {
    // WebP: RIFF....WEBP
    if (buf.toString('ascii', 0, 4) === 'RIFF' && buf.toString('ascii', 8, 12) === 'WEBP') {
      return 'image/webp';
    }
    // HEIC/HEIF: bytes 4..8 == 'ftyp', brand at bytes 8..12
    if (buf.toString('ascii', 4, 8) === 'ftyp') {
      const brand = buf.toString('ascii', 8, 12).toLowerCase();
      if (['heic', 'heix', 'hevc', 'hevx', 'heim', 'heis'].includes(brand)) {
        return 'image/heic';
      }
      if (['mif1', 'msf1'].includes(brand)) {
        return 'image/heif';
      }
    }
  }

  return null;
}

function isPrivateIPv4(ip: string): boolean {
  const parts = ip.split('.').map(Number);
  if (parts.length !== 4 || parts.some((p) => Number.isNaN(p))) return true; // fail closed
  const [a, b] = parts;
  if (a === 0 || a === 10 || a === 127) return true;
  if (a === 169 && b === 254) return true; // link-local
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 192 && b === 168) return true;
  if (a === 100 && b >= 64 && b <= 127) return true; // CGNAT
  return false;
}

function isPrivateIPv6(ip: string): boolean {
  const lower = ip.toLowerCase();
  if (lower === '::' || lower === '::1') return true;
  if (lower.startsWith('::ffff:')) return isPrivateIPv4(lower.slice(7));
  if (lower.startsWith('fe80:')) return true; // link-local
  if (lower.startsWith('fc') || lower.startsWith('fd')) return true; // ULA
  return false;
}

async function isHostAllowed(hostname: string): Promise<boolean> {
  if (allowPrivateHosts()) return true;

  const host = hostname.replace(/^\[|\]$/g, '');
  const kind = isIP(host);
  if (kind === 4) return !isPrivateIPv4(host);
  if (kind === 6) return !isPrivateIPv6(host);
  if (host.toLowerCase() === 'localhost') return false;

  // Resolve hostnames and require every resolved address to be non-private.
  try {
    const addrs = await lookup(host, { all: true });
    if (addrs.length === 0) return false;
    return addrs.every((a) => (a.family === 4 ? !isPrivateIPv4(a.address) : !isPrivateIPv6(a.address)));
  } catch {
    return false;
  }
}

function extractUrl(ref: unknown): string | null {
  if (typeof ref === 'string') return ref.trim() || null;
  if (ref && typeof ref === 'object') {
    const obj = ref as Record<string, unknown>;
    if (typeof obj.url === 'string') return obj.url.trim() || null;
    if (typeof obj.image_url === 'string') return obj.image_url.trim() || null;
  }
  return null;
}

/** Resolves a base64 `data:` URL into `inlineData`, honouring budget caps. */
function resolveDataUrl(url: string, budget: ImageBudget): ImageResolution {
  const comma = url.indexOf(',');
  if (comma < 0) return { omitted: 'malformed data URL' };

  const meta = url.slice(5, comma);
  const payload = url.slice(comma + 1);
  const metaParts = meta.split(';').map((p) => p.trim()).filter(Boolean);
  const isBase64 = metaParts.some((p) => p.toLowerCase() === 'base64');

  let bytes: Buffer;
  try {
    if (isBase64) {
      let cleaned = payload.replace(/\s+/g, '');
      if (cleaned.length === 0) return { omitted: 'empty image' };
      // Strict validation: Buffer.from() silently drops unknown characters,
      // which would turn garbage into a bogus image. Reject it explicitly.
      if (!/^[A-Za-z0-9+/_-]+={0,2}$/.test(cleaned) || cleaned.length % 4 === 1) {
        return { omitted: 'invalid base64 payload' };
      }
      // Normalise base64url variants to standard base64.
      cleaned = cleaned.replace(/-/g, '+').replace(/_/g, '/');
      bytes = Buffer.from(cleaned, 'base64');
    } else {
      bytes = Buffer.from(decodeURIComponent(payload), 'latin1');
    }
  } catch {
    return { omitted: 'invalid base64 payload' };
  }

  if (bytes.length === 0) return { omitted: 'empty image' };
  if (bytes.length > MAX_IMAGE_BYTES) return { omitted: 'image exceeds 8MB limit' };
  if (bytes.length > budget.remainingBytes) return { omitted: 'image exceeds request image budget' };

  // Data URLs must be verifiable from magic bytes; a forged MIME declaration
  // is never trusted on its own.
  const mime = sniffImageMime(bytes);
  if (!mime) return { omitted: 'unsupported image format' };

  budget.remainingBytes -= bytes.length;
  return { inlineData: { mimeType: mime, data: bytes.toString('base64') } };
}

async function readBodyWithLimit(res: Response, max: number): Promise<Buffer | null> {
  if (!res.body) return null;
  const reader = res.body.getReader();
  const chunks: Buffer[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > max) {
        try { await reader.cancel(); } catch {}
        return null;
      }
      chunks.push(Buffer.from(value));
    }
  } catch {
    try { await reader.cancel(); } catch {}
    return null;
  }
  return Buffer.concat(chunks);
}

async function fetchRemote(url: string, budget: ImageBudget): Promise<ImageResolution> {
  let current = url;
  try {
    for (let i = 0; i <= MAX_REDIRECTS; i++) {
      const parsed = new URL(current);
      if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
        return { omitted: 'unsupported URL scheme' };
      }
      if (!(await isHostAllowed(parsed.hostname))) {
        log.warn('Blocked remote image (private/loopback host)', { host: parsed.hostname });
        return { omitted: 'blocked host (private/loopback address)' };
      }

      const res = await fetch(current, {
        method: 'GET',
        redirect: 'manual',
        signal: AbortSignal.timeout(IMAGE_FETCH_TIMEOUT_MS),
        headers: { Accept: 'image/*', 'User-Agent': 'openai-proxy-for-antigravity' },
      });

      if (res.status >= 300 && res.status < 400) {
        const location = res.headers.get('location');
        if (!location) return { omitted: `redirect ${res.status} without location` };
        current = new URL(location, current).toString();
        continue;
      }
      if (!res.ok) {
        try { await res.body?.cancel(); } catch {}
        return { omitted: `fetch failed (HTTP ${res.status})` };
      }

      const contentLength = Number(res.headers.get('content-length') || 0);
      if (contentLength > MAX_IMAGE_BYTES) {
        try { await res.body?.cancel(); } catch {}
        return { omitted: 'image exceeds 8MB limit' };
      }

      const bytes = await readBodyWithLimit(res, MAX_IMAGE_BYTES);
      if (!bytes || bytes.length === 0) return { omitted: 'empty or unreadable image' };
      if (bytes.length > budget.remainingBytes) {
        return { omitted: 'image exceeds request image budget' };
      }

      const sniffed = sniffImageMime(bytes);
      const headerMime = (res.headers.get('content-type') || '').split(';')[0].trim().toLowerCase();
      const mime = sniffed ?? (ALLOWED_MIMES.has(headerMime) ? headerMime : null);
      if (!mime) {
        log.warn('Remote image rejected (unsupported format)', {
          host: parsed.hostname,
          headerMime: headerMime || 'none',
        });
        return { omitted: 'unsupported image format' };
      }

      budget.remainingBytes -= bytes.length;
      log.info('Fetched remote image', {
        host: parsed.hostname,
        path: parsed.pathname.slice(0, 60),
        bytes: bytes.length,
        mime,
      });
      return { inlineData: { mimeType: mime, data: bytes.toString('base64') } };
    }
    return { omitted: 'too many redirects' };
  } catch (err) {
    const name = err instanceof Error ? err.name : '';
    const reason = name === 'TimeoutError' ? 'fetch timed out' : 'fetch failed';
    log.warn('Remote image fetch error', { reason, host: safeHost(url) });
    return { omitted: reason };
  }
}

function safeHost(url: string): string {
  try {
    return new URL(url).hostname;
  } catch {
    return 'unknown';
  }
}

/**
 * Resolves an OpenAI `image_url` reference (string / data URL / remote URL)
 * into an Antigravity-native `inlineData` part, or a human-readable omission
 * reason. Never throws.
 */
export async function resolveImageRef(ref: unknown, budget: ImageBudget): Promise<ImageResolution> {
  const url = extractUrl(ref);
  if (!url) return { omitted: 'unsupported image reference' };
  if (url.startsWith('data:')) return resolveDataUrl(url, budget);
  if (/^https?:\/\//i.test(url)) return fetchRemote(url, budget);
  return { omitted: 'unsupported URL scheme' };
}
