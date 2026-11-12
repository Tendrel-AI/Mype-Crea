/**
 * KAN-87 brand uploads: what a file is is decided by its BYTES (never the client MIME), SVG is only
 * accepted when it is inert, and the object storage always resolves (the in-memory fallback is used
 * locally when no bucket is configured; production without a bucket fails closed in `getObjectStorage`).
 */
import { loggerFor } from '../logger';
import { getObjectStorage } from './index';
import { InMemoryObjectStorage } from './memory-storage';
import type { IObjectStorage } from './types';

const log = loggerFor('services.storage.brand-upload');

export const MAX_UPLOAD_BYTES = 5 * 1024 * 1024;

export interface SniffedImage {
  readonly contentType: 'image/png' | 'image/jpeg' | 'image/webp' | 'image/svg+xml';
  readonly extension: 'png' | 'jpg' | 'webp' | 'svg';
}

const startsWith = (bytes: Uint8Array, signature: ReadonlyArray<number>, offset = 0) =>
  signature.every((byte, i) => bytes[offset + i] === byte);

/** D32: a lab report is a PDF, decided by its `%PDF-` magic bytes. */
export const isPdf = (bytes: Uint8Array): boolean => startsWith(bytes, [0x25, 0x50, 0x44, 0x46, 0x2d]);

/** SVG accepted only without scripts, event handlers, foreignObject, entities or external references. */
export function isSafeSvg(text: string): boolean {
  const body = text.replace(/^﻿/, '');
  if (!/^\s*(<\?xml[^>]*\?>\s*)?(<!--[\s\S]*?-->\s*)*(<!DOCTYPE svg[^>[]*>\s*)?<svg[\s>]/i.test(body)) return false;
  if (!/<\/svg\s*>\s*$/i.test(body) && !/\/>\s*$/.test(body)) return false;
  if (/<\s*(script|foreignObject|iframe|embed|object|animate|set)\b/i.test(body)) return false;
  if (/<!ENTITY/i.test(body) || /\son[a-z]+\s*=/i.test(body) || /javascript:/i.test(body)) return false;
  // Only in-document references (`#id`); no external href, @import or url().
  if (/(?:xlink:)?href\s*=\s*(?!["']?\s*#)/i.test(body)) return false;
  if (/@import/i.test(body) || /url\(\s*(?!["']?\s*#)/i.test(body)) return false;
  return true;
}

/** PNG, JPEG, WebP by magic bytes; SVG by parsing the text. Anything else is null. */
export function sniffImage(bytes: Uint8Array): SniffedImage | null {
  if (startsWith(bytes, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return { contentType: 'image/png', extension: 'png' };
  if (startsWith(bytes, [0xff, 0xd8, 0xff])) return { contentType: 'image/jpeg', extension: 'jpg' };
  if (startsWith(bytes, [0x52, 0x49, 0x46, 0x46]) && startsWith(bytes, [0x57, 0x45, 0x42, 0x50], 8)) {
    return { contentType: 'image/webp', extension: 'webp' };
  }
  try {
    const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    return isSafeSvg(text) ? { contentType: 'image/svg+xml', extension: 'svg' } : null;
  } catch {
    return null;
  }
}

/** Control characters and path parts removed, at most 200 characters (the column limit). */
export function safeOriginalName(name: string): string {
  const base = name.split(/[\\/]/).pop() ?? '';
  const cleaned = base.replace(/[\p{Cc}]/gu, '').trim().slice(0, 200);
  return cleaned || 'archivo';
}

// Cached on globalThis (like the runtime/Redis/notifiers) so every Next.js bundle in the process
// (route handlers, label-agent worker) shares one in-memory store; the warning logs once per process.
const DEV_STORAGE_SLOT = Symbol.for('mypes.storage.brand-dev-fallback');
type DevStorageHolder = { [DEV_STORAGE_SLOT]?: InMemoryObjectStorage };
const holder = globalThis as unknown as DevStorageHolder;

/** The configured bucket, or an in-memory store when none is configured (local only). */
export function brandFileStorage(): IObjectStorage {
  const configured = getObjectStorage();
  if (configured) return configured;
  if (!holder[DEV_STORAGE_SLOT]) {
    log.warn('brand uploads use in-memory storage (no bucket configured): files are lost on restart');
    holder[DEV_STORAGE_SLOT] = new InMemoryObjectStorage();
  }
  return holder[DEV_STORAGE_SLOT];
}

/** Inert-by-default headers for serving an uploaded file (SVG included). */
export const FILE_RESPONSE_HEADERS = {
  'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'; sandbox",
  'X-Content-Type-Options': 'nosniff',
  'Content-Disposition': 'inline',
  'Cache-Control': 'private, no-store',
} as const;
