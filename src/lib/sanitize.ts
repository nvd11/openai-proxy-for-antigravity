/**
 * Log sanitizer — strips base64 / oversized payloads from any object before
 * it is serialised into logs or the in-memory request log store.
 *
 * Guarantees: no base64 image content, no huge strings and no deep object
 * cycles can ever reach the console or the dashboard logs.
 */

const MAX_STRING_CHARS = 4096;
const MAX_ARRAY_ITEMS = 50;
const MAX_DEPTH = 8;

function summarizeString(value: string): string {
  if (value.startsWith('data:')) {
    const comma = value.indexOf(',');
    const meta = comma > 5 ? value.slice(5, comma) : '';
    const mime = meta.split(';')[0] || 'unknown';
    return `[data-url ${mime} ${value.length} chars]`;
  }
  if (value.length > MAX_STRING_CHARS) {
    return `[string ${value.length} chars]`;
  }
  return value;
}

function summarizeImageRef(ref: unknown): unknown {
  if (typeof ref === 'string') return summarizeString(ref);
  if (ref && typeof ref === 'object') {
    const obj = ref as Record<string, unknown>;
    if (typeof obj.url === 'string') {
      return { ...obj, url: summarizeString(obj.url) };
    }
  }
  return '[image]';
}

/**
 * Deep-sanitises a value for logging. Replaces base64/oversized strings with
 * short markers and caps array length & depth to bound memory usage.
 */
export function sanitizeForLog(value: unknown, depth = 0): unknown {
  if (value === null || value === undefined) return value;
  if (typeof value === 'string') return summarizeString(value);
  if (typeof value !== 'object') return value;
  if (depth > MAX_DEPTH) return '[max depth]';

  if (Array.isArray(value)) {
    const items = value.slice(0, MAX_ARRAY_ITEMS);
    return items.map((item) => sanitizeForLog(item, depth + 1));
  }

  const result: Record<string, unknown> = {};
  for (const [key, val] of Object.entries(value as Record<string, unknown>)) {
    if (key === 'image_url' || key === 'input_image') {
      result[key] = summarizeImageRef(val);
    } else if (key === 'inlineData' && val && typeof val === 'object') {
      const d = val as Record<string, unknown>;
      result[key] = { mimeType: d.mimeType, data: `[base64 ${String(d.data || '').length} chars]` };
    } else {
      result[key] = sanitizeForLog(val, depth + 1);
    }
  }
  return result;
}
