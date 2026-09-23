import type { SourceChunk, SourceIndex } from './index-types';
import type { Item } from './types';

export const CHUNK_VERSION = 1;
const SHA_CONSTANTS = new Uint32Array([
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
  0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
  0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
  0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
  0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
  0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
]);
const rotate = (value: number, bits: number) => (value >>> bits) | (value << (32 - bits));

// Synchronous hashing also works inside IndexedDB transactions and for config keys.
export function sha256(text: string): string {
  const input = new TextEncoder().encode(text);
  const bytes = new Uint8Array(Math.ceil((input.length + 9) / 64) * 64);
  bytes.set(input);
  bytes[input.length] = 0x80;
  const view = new DataView(bytes.buffer);
  view.setUint32(bytes.length - 8, Math.floor(input.length / 0x20000000));
  view.setUint32(bytes.length - 4, input.length * 8);
  const state = new Uint32Array([0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19]);
  const words = new Uint32Array(64);
  for (let offset = 0; offset < bytes.length; offset += 64) {
    for (let i = 0; i < 16; i++) words[i] = view.getUint32(offset + i * 4);
    for (let i = 16; i < 64; i++) {
      const a = words[i - 15]!;
      const b = words[i - 2]!;
      words[i] = words[i - 16]! + (rotate(a, 7) ^ rotate(a, 18) ^ (a >>> 3))
        + words[i - 7]! + (rotate(b, 17) ^ rotate(b, 19) ^ (b >>> 10));
    }
    let [a, b, c, d, e, f, g, h] = Array.from(state) as [number, number, number, number, number, number, number, number];
    for (let i = 0; i < 64; i++) {
      const t1 = (h + (rotate(e, 6) ^ rotate(e, 11) ^ rotate(e, 25)) + ((e & f) ^ (~e & g)) + SHA_CONSTANTS[i]! + words[i]!) >>> 0;
      const t2 = ((rotate(a, 2) ^ rotate(a, 13) ^ rotate(a, 22)) + ((a & b) ^ (a & c) ^ (b & c))) >>> 0;
      h = g; g = f; f = e; e = (d + t1) >>> 0; d = c; c = b; b = a; a = (t1 + t2) >>> 0;
    }
    for (const [i, value] of [a, b, c, d, e, f, g, h].entries()) state[i] = state[i]! + value;
  }
  return Array.from(state, value => value.toString(16).padStart(8, '0')).join('');
}

export function sourceHash(item: Item): string {
  return `v${CHUNK_VERSION}:${sha256(JSON.stringify([
    item.url, item.normalizedUrl, item.source, item.githubVisibility ?? '', item.title,
    item.description, item.excerpt, item.content, item.tags,
    item.github ? [item.github.owner, item.github.repo, item.github.language, item.github.license,
      item.github.stars, item.github.topics, item.github.repoId ?? null] : null,
  ]))}`;
}

// Body offsets refer to this source-only text, including a distinct captured excerpt.
export function sourceBody(item: Item): string {
  if (!item.content.trim()) return item.excerpt;
  return item.excerpt.trim() && !item.content.includes(item.excerpt.trim())
    ? `${item.content}\n\n${item.excerpt}` : item.content;
}

export function contentState(item: Item): SourceIndex['contentState'] {
  if (item.content.trim()) return 'body';
  if (item.description.trim() || item.excerpt.trim()) return 'summary';
  return 'link';
}

interface Piece { start: number; end: number; heading: string }
function splitRange(text: string, start: number, end: number, heading: string): Piece[] {
  const pieces: Piece[] = [];
  while (start < end) {
    // Character bounds are a conservative heuristic, not an exact token count.
    const sample = text.slice(start, Math.min(start + 1000, end));
    const limit = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/u.test(sample) ? 400 : 1000;
    let stop = Math.min(start + limit, end);
    if (stop < end) {
      const newline = text.lastIndexOf('\n', stop - 1);
      const space = text.lastIndexOf(' ', stop - 1);
      const boundary = Math.max(newline, space);
      if (boundary >= start + Math.floor(limit / 2)) stop = boundary + 1;
      if (/[\uD800-\uDBFF]/u.test(text[stop - 1]!)) stop--;
    }
    if (text.slice(start, stop).trim()) pieces.push({ start, end: stop, heading });
    start = stop;
  }
  return pieces;
}

function markdownPieces(text: string): Piece[] {
  const pieces: Piece[] = [];
  let start = 0;
  let heading = '';
  let fence = '';
  const flush = (end: number) => {
    pieces.push(...splitRange(text, start, end, heading));
    start = end;
  };
  for (const line of text.matchAll(/[^\n]*(?:\n|$)/gu)) {
    const offset = line.index;
    const value = line[0];
    if (!value) continue;
    const marker = /^\s{0,3}(`{3,}|~{3,})/u.exec(value)?.[1];
    if (fence) {
      if (marker && marker[0] === fence[0] && marker.length >= fence.length
        && value.trim() === marker) fence = '';
      continue;
    }
    if (marker) { flush(offset); fence = marker; continue; }
    const title = /^\s{0,3}#{1,6}\s+(.+?)\s*#*\s*$/u.exec(value)?.[1];
    if (title) { flush(offset); heading = title.slice(0, 300); }
    else if (!value.trim()) { flush(offset); start = offset + value.length; }
  }
  flush(text.length);
  return pieces;
}

export function chunkItem(item: Item, hash = sourceHash(item)): SourceChunk[] {
  const chunks: SourceChunk[] = [];
  const append = (text: string, kind: SourceChunk['kind'], pieces: Piece[]) => {
    for (const piece of pieces) {
      const position = chunks.length;
      chunks.push({ id: `${item.id}:${hash}:${position}`, itemId: item.id, position,
        heading: piece.heading, text: text.slice(piece.start, piece.end), kind, sourceHash: hash,
        start: piece.start, end: piece.end });
    }
  };
  const metadata = item.github ? [item.github.owner, item.github.repo, item.github.language,
    item.github.license, ...item.github.topics].filter(Boolean).join(' · ') : '';
  const facts = [item.description, item.tags.join(' · '), metadata].filter(value => value.trim());
  // A title-only bookmark is not source evidence for a claimed capability.
  if (facts.length) {
    const overview = [item.title.slice(0, 160), ...facts].join(' · ');
    append(overview, 'overview', splitRange(overview, 0, overview.length, ''));
  }
  const body = sourceBody(item);
  append(body, 'body', markdownPieces(body));
  return chunks;
}
