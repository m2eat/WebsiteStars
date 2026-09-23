import Dexie, { type EntityTable } from 'dexie';
import { z } from 'zod';
import type { ChatMessage, ChatRun, ChatSession } from './chat-types';
import type { ChunkVector, SourceChunk, SourceIndex } from './index-types';
import type { Analysis, Capture, Item, ItemPatch, Job } from './types';
import { normalizeUrl, parseGithubRepo } from './urls';

export const db = new Dexie('starts') as Dexie & {
  items: EntityTable<Item, 'id'>;
  jobs: EntityTable<Job, 'itemId'>;
  chatSessions: EntityTable<ChatSession, 'id'>;
  chatMessages: EntityTable<ChatMessage, 'id'>;
  chatRuns: EntityTable<ChatRun, 'id'>;
  sourceChunks: EntityTable<SourceChunk, 'id'>;
  sourceIndexes: EntityTable<SourceIndex, 'itemId'>;
  chunkVectors: EntityTable<ChunkVector, 'id'>;
};
db.version(1).stores({
  items: 'id, &normalizedUrl, source, createdAt, updatedAt, *tags, category',
  jobs: 'itemId, status, nextAttempt, leaseUntil',
});

db.version(2).stores({
  chatSessions: 'id, updatedAt, status',
  chatMessages: 'id, sessionId, [sessionId+sequence], runId',
  chatRuns: 'id, sessionId, status, updatedAt',
});

db.version(3).stores({
  sourceChunks: 'id, itemId, [itemId+position], sourceHash',
  sourceIndexes: 'itemId, status, embeddingKey',
  chunkVectors: 'id, itemId, chunkId, embeddingKey, [embeddingKey+sourceHash]',
});

const MAX_BACKUP_BYTES = 50 * 1024 * 1024;
const text = (max: number) => z.string().max(max).refine(
  (value) => !/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u.test(value),
  '文本含有不支持的控制字符',
);
const labels = z.array(text(200)).max(100);
const timestamp = z.string().max(40).datetime({ offset: true });
const source = z.enum(['github', 'article', 'docs']);
const safeUrl = text(8192).refine((value) => {
  try {
    normalizeUrl(value);
    return true;
  } catch {
    return false;
  }
}, 'URL 必须是无凭证的 HTTP 或 HTTPS 地址');
const githubSchema = z.object({
  repoId: z.number().int().positive().safe().optional(),
  owner: z.string().max(39).regex(/^[a-z\d](?:[a-z\d-]{0,37}[a-z\d])?$/iu),
  repo: z.string().max(100).regex(/^[a-z\d_.-]+$/iu)
    .refine((value) => value !== '.' && value !== '..'),
  language: text(200), license: text(200), stars: z.number().int().nonnegative().safe(),
  topics: labels, fetchedAt: timestamp,
}).strict();
const analysisSchema = z.object({
  summary: text(20000), category: text(200), tags: labels, keywords: labels,
  stack: labels, useCases: z.array(text(2000)).max(100),
  provider: text(200), model: text(300), analyzedAt: timestamp,
}).strict();
const itemSchema = z.object({
  id: z.string().max(128).regex(/^[a-z\d][a-z\d_-]*$/iu)
    .refine((value) => !['__proto__', 'constructor', 'prototype'].includes(value)),
  url: safeUrl, normalizedUrl: safeUrl, title: text(2000), description: text(20000),
  excerpt: text(20000), content: text(1000000), truncated: z.boolean(), source,
  domain: text(253), author: text(2000), publishedAt: text(200),
  tags: labels, keywords: labels, category: text(200), notes: text(100000),
  selections: z.array(text(20000)).max(100), summaryOverride: text(20000).optional(),
  tagsOverride: labels.optional(), categoryOverride: text(200).optional(),
  ai: analysisSchema.optional(),
  analysisStatus: z.enum(['disabled', 'pending', 'running', 'succeeded', 'failed']),
  analysisError: text(2000).optional(), github: githubSchema.optional(),
  githubVisibility: z.enum(['public', 'private']).optional(),
  createdAt: timestamp, updatedAt: timestamp, contentVersion: z.number().int().positive().safe(),
}).strict().superRefine((item, context) => {
  try {
    if (normalizeUrl(item.url) !== item.normalizedUrl) {
      context.addIssue({ code: 'custom', path: ['normalizedUrl'], message: '规范 URL 与原 URL 不一致' });
    }
    if (new URL(item.url).hostname !== item.domain) {
      context.addIssue({ code: 'custom', path: ['domain'], message: '域名与 URL 不一致' });
    }
  } catch {
    context.addIssue({ code: 'custom', path: ['url'], message: '无效 URL' });
  }
});
const captureSchema = z.object({
  url: safeUrl, title: text(2000).optional(), canonicalUrl: text(8192).optional(),
  description: text(20000).optional(), excerpt: text(20000).optional(),
  content: text(1000000).optional(), truncated: z.boolean().optional(), source: source.optional(),
  author: text(2000).optional(), publishedAt: text(200).optional(),
  selection: text(20000).optional(), tags: labels.optional(), keywords: labels.optional(),
  github: githubSchema.optional(),
}).strict();
const patchSchema = z.object({
  title: text(2000).optional(), notes: text(100000).optional(),
  summaryOverride: text(20000).optional(), tagsOverride: labels.optional(),
  categoryOverride: text(200).optional(),
}).strict();
const backupSchema = z.object({
  schemaVersion: z.literal(1), exportedAt: timestamp, items: z.array(itemSchema).max(10000),
}).strict();

export function parseAnalysis(value: unknown): Analysis {
  return analysisSchema.parse(value);
}

export function displaySummary(item: Item): string {
  return item.summaryOverride ?? (item.ai?.summary || item.description || item.excerpt);
}

export function displayTags(item: Item): string[] {
  return item.tagsOverride ?? [...new Set([...item.tags, ...(item.ai?.tags ?? [])])];
}

export function displayCategory(item: Item): string {
  return item.categoryOverride ?? (item.ai?.category || item.category);
}

function appendSelection(item: Item, selection?: string): boolean {
  const value = selection?.trim();
  if (!value || item.selections.includes(value)) return false;
  item.selections = [...item.selections, value];
  return true;
}

export async function saveCapture(capture: Capture): Promise<{ item: Item; created: boolean }> {
  const value = captureSchema.parse(capture);
  const normalizedUrl = normalizeUrl(value.url, value.canonicalUrl);
  return db.transaction('rw', db.items, async () => {
    const existing = await db.items.where('normalizedUrl').equals(normalizedUrl).first();
    if (existing) {
      if (appendSelection(existing, value.selection)) {
        existing.updatedAt = new Date().toISOString();
        await db.items.put(itemSchema.parse(existing));
      }
      return { item: existing, created: false };
    }
    const now = new Date().toISOString();
    const url = new URL(value.url);
    const item: Item = itemSchema.parse({
      id: crypto.randomUUID(), url: url.href, normalizedUrl,
      title: value.title?.trim() || url.href, description: value.description ?? '',
      excerpt: value.excerpt ?? '', content: value.content ?? '', truncated: value.truncated ?? false,
      source: value.source ?? (parseGithubRepo(value.url) ? 'github' : 'article'),
      domain: url.hostname, author: value.author ?? '', publishedAt: value.publishedAt ?? '',
      tags: value.tags ?? value.github?.topics ?? [], keywords: value.keywords ?? [],
      category: '', notes: '', selections: value.selection?.trim() ? [value.selection.trim()] : [],
      github: value.github, analysisStatus: 'disabled', createdAt: now, updatedAt: now, contentVersion: 1,
    });
    await db.items.add(item);
    return { item, created: true };
  });
}

export async function enrichItem(
  id: string, capture: Capture, expectedContentVersion?: number,
): Promise<Item | undefined> {
  const value = captureSchema.parse(capture);
  return db.transaction('rw', db.items, async () => {
    const item = await db.items.get(id);
    if (!item || (expectedContentVersion !== undefined && item.contentVersion !== expectedContentVersion)) {
      return undefined;
    }
    if (normalizeUrl(value.url, value.canonicalUrl) !== item.normalizedUrl) {
      throw new Error('补全内容的 URL 与收藏不一致');
    }
    const next: Item = { ...item };
    // Title has no separate override in the contract, so enrichment preserves it.
    if (value.description !== undefined) next.description = value.description;
    if (value.excerpt !== undefined) next.excerpt = value.excerpt;
    if (value.content !== undefined) next.content = value.content;
    if (value.truncated !== undefined) next.truncated = value.truncated;
    if (value.source !== undefined) next.source = value.source;
    if (value.author !== undefined) next.author = value.author;
    if (value.publishedAt !== undefined) next.publishedAt = value.publishedAt;
    if (value.tags !== undefined) next.tags = value.tags;
    if (value.keywords !== undefined) next.keywords = value.keywords;
    if (value.github !== undefined) next.github = value.github;
    const contentChanged = next.description !== item.description || next.excerpt !== item.excerpt
      || next.content !== item.content || next.truncated !== item.truncated
      || next.source !== item.source || next.author !== item.author || next.publishedAt !== item.publishedAt
      || JSON.stringify(next.tags) !== JSON.stringify(item.tags)
      || JSON.stringify(next.keywords) !== JSON.stringify(item.keywords)
      || JSON.stringify(next.github) !== JSON.stringify(item.github);
    const selectionChanged = appendSelection(next, value.selection);
    if (!contentChanged && !selectionChanged) return item;
    if (contentChanged) next.contentVersion += 1;
    next.updatedAt = new Date().toISOString();
    const result = itemSchema.parse(next);
    await db.items.put(result);
    return result;
  });
}

export async function updateItem(id: string, patch: ItemPatch): Promise<Item> {
  const value = patchSchema.parse(patch);
  return db.transaction('rw', db.items, async () => {
    const item = await db.items.get(id);
    if (!item) throw new Error('收藏不存在或已被删除');
    for (const key of ['title', 'notes', 'summaryOverride', 'tagsOverride', 'categoryOverride'] as const) {
      if (!Object.prototype.hasOwnProperty.call(value, key)) continue;
      if (key === 'tagsOverride') item.tagsOverride = value.tagsOverride;
      else if (key === 'title' || key === 'notes') {
        if (value[key] !== undefined) item[key] = value[key];
      } else item[key] = value[key];
    }
    item.updatedAt = new Date().toISOString();
    const result = itemSchema.parse(item);
    await db.items.put(result);
    return result;
  });
}

export async function deleteItem(id: string): Promise<void> {
  await db.transaction('rw', [db.items, db.jobs, db.sourceChunks, db.sourceIndexes, db.chunkVectors], async () => {
    await db.items.delete(id);
    await db.jobs.delete(id);
    await db.sourceChunks.where('itemId').equals(id).delete();
    await db.sourceIndexes.delete(id);
    await db.chunkVectors.where('itemId').equals(id).delete();
  });
}

export async function exportBackup(): Promise<string> {
  const items = await db.items.toArray();
  const backup = backupSchema.parse({ schemaVersion: 1, exportedAt: new Date().toISOString(), items });
  const result = JSON.stringify(backup, null, 2);
  if (new TextEncoder().encode(result).byteLength > MAX_BACKUP_BYTES) {
    throw new Error('备份超过 50 MiB 大小限制');
  }
  return result;
}

export function parseBackup(value: string): Item[] {
  if (typeof value !== 'string' || value.length > MAX_BACKUP_BYTES
    || new TextEncoder().encode(value).byteLength > MAX_BACKUP_BYTES) {
    throw new Error('备份超过 50 MiB 大小限制');
  }
  const parsed: unknown = JSON.parse(value);
  return backupSchema.parse(parsed).items;
}

export async function importBackup(value: string): Promise<{ added: number; skipped: number }> {
  const items = parseBackup(value);
  return db.transaction('rw', db.items, db.jobs, async () => {
    let added = 0;
    let skipped = 0;
    for (const item of items) {
      if (await db.items.get(item.id)
        || await db.items.where('normalizedUrl').equals(item.normalizedUrl).first()) {
        skipped += 1;
        continue;
      }
      if (item.analysisStatus === 'pending' || item.analysisStatus === 'running') {
        item.analysisStatus = 'disabled';
        delete item.analysisError;
      }
      await db.items.add(item);
      await db.jobs.delete(item.id);
      added += 1;
    }
    return { added, skipped };
  });
}
