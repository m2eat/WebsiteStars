import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import {
  db, deleteItem, displayCategory, displaySummary, displayTags, enrichItem,
  exportBackup, importBackup, parseBackup, saveCapture, updateItem,
} from '../lib/library';
import type { Item, Job } from '../lib/types';

const now = '2026-09-22T10:00:00.000Z';
function fixture(id = 'restored'): Item {
  return {
    id, url: `https://github.com/example/${id}`, normalizedUrl: `https://github.com/example/${id}`,
    title: '保留的标题', description: '来源简介', excerpt: '原始摘录', content: '# README\n完整正文',
    truncated: true, source: 'github', domain: 'github.com', author: '作者', publishedAt: '2026-09-01',
    tags: ['来源标签'], keywords: ['keyword'], category: '来源分类', notes: '私人笔记\n第二行',
    selections: ['第一段选区', '第二段选区'], summaryOverride: '人工摘要', tagsOverride: ['手工标签'],
    categoryOverride: '人工分类', analysisStatus: 'succeeded', analysisError: '上次错误',
    ai: {
      summary: '模型摘要', category: '模型分类', tags: ['模型标签'], keywords: ['检索词'],
      stack: ['C++'], useCases: ['终端界面'], provider: 'compatible', model: 'model', analyzedAt: now,
    },
    github: {
      repoId: 123, owner: 'example', repo: id, language: 'C++', license: 'MIT',
      stars: 42, topics: ['cli'], fetchedAt: now,
    },
    createdAt: now, updatedAt: now, contentVersion: 4,
  };
}
function backup(items: unknown[], extra: Record<string, unknown> = {}): string {
  return JSON.stringify({ schemaVersion: 1, exportedAt: now, items, ...extra });
}
function job(itemId: string): Job {
  return { itemId, contentVersion: 1, settingsRevision: 1, status: 'running', attempts: 1, nextAttempt: 0, leaseUntil: 100 };
}

beforeEach(async () => {
  await db.transaction('rw', db.items, db.jobs, async () => {
    await db.items.clear();
    await db.jobs.clear();
  });
});
afterAll(() => db.close());

describe('capture and enrichment', () => {
  it('serializes concurrent duplicate saves and retains all distinct selections', async () => {
    const results = await Promise.all(Array.from({ length: 16 }, (_, index) => saveCapture({
      url: `https://example.com/docs?v=2&utm_source=${index}#heading`,
      title: '原始标题', content: `snapshot ${index}`, selection: `选区 ${index % 4}`,
    })));
    expect(results.filter((result) => result.created)).toHaveLength(1);
    expect(new Set(results.map((result) => result.item.id)).size).toBe(1);
    const item = (await db.items.toArray())[0]!;
    expect(await db.items.count()).toBe(1);
    expect(item.id).toMatch(/^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/u);
    expect(item.selections.sort()).toEqual(['选区 0', '选区 1', '选区 2', '选区 3']);
    expect(item.content).toBe(results.find((result) => result.created)!.item.content);
    expect(item.contentVersion).toBe(1);
    expect(item.analysisStatus).toBe('disabled');
    expect(await db.jobs.count()).toBe(0);
  });

  it('does not refresh content or clear manual fields during a duplicate save', async () => {
    const { item } = await saveCapture({ url: 'https://example.com/docs', content: 'snapshot', selection: ' first ' });
    const edited = await updateItem(item.id, {
      title: '人工标题', notes: '重要笔记', summaryOverride: '', tagsOverride: [], categoryOverride: '自定义',
    });
    const repeated = await saveCapture({
      url: `${item.url}?fbclid=tracking`, title: '不同标题', content: 'changed', tags: ['new'], selection: 'first',
    });
    expect(repeated).toEqual({ created: false, item: edited });
    const appended = await saveCapture({ url: item.url, selection: 'second' });
    expect(appended.item).toMatchObject({ ...edited, updatedAt: expect.any(String), selections: ['first', 'second'] });
  });

  it('preserves human edits through enrichment and increments versions only for changed source data', async () => {
    const original = fixture();
    await db.items.add(original);
    await updateItem(original.id, { title: '我的标题', notes: '我的笔记', summaryOverride: '', tagsOverride: [], categoryOverride: '' });
    const result = await enrichItem(original.id, {
      url: original.url, title: '抓取标题', content: '更新正文', description: '新简介', tags: ['新来源标签'],
    }, original.contentVersion);
    expect(result).toMatchObject({
      title: '我的标题', notes: '我的笔记', summaryOverride: '', tagsOverride: [], categoryOverride: '',
      content: '更新正文', description: '新简介', tags: ['新来源标签'], contentVersion: 5, ai: original.ai,
      selections: original.selections, createdAt: original.createdAt,
    });
    expect(displaySummary(result!)).toBe('');
    expect(displayTags(result!)).toEqual([]);
    expect(displayCategory(result!)).toBe('');
    expect(await enrichItem(original.id, { url: original.url, content: '更新正文' }, 5)).toEqual(result);
    const selection = await enrichItem(original.id, { url: original.url, selection: 'new selection' }, 5);
    expect(selection?.contentVersion).toBe(5);
    expect(await enrichItem(original.id, { url: original.url, content: 'stale response' }, 4)).toBeUndefined();
    expect((await db.items.get(original.id))?.content).toBe('更新正文');
  });

  it('rejects mismatched enrichment URLs without changing the item', async () => {
    const item = fixture();
    await db.items.add(item);
    await expect(enrichItem(item.id, { url: 'https://example.com/other', content: 'wrong' })).rejects.toThrow();
    expect(await db.items.get(item.id)).toEqual(item);
  });

  it('deletes the job and never resurrects a deleted item through late enrichment or edits', async () => {
    const { item } = await saveCapture({ url: 'https://example.com/deleted' });
    await db.jobs.add(job(item.id));
    await Promise.all([
      enrichItem(item.id, { url: item.url, content: 'in flight' }, 1),
      deleteItem(item.id),
    ]);
    expect(await enrichItem(item.id, { url: item.url, content: 'late response' }, 1)).toBeUndefined();
    await expect(updateItem(item.id, { notes: 'late edit' })).rejects.toThrow();
    expect(await db.items.get(item.id)).toBeUndefined();
    expect(await db.jobs.get(item.id)).toBeUndefined();
  });

  it('rolls back item deletion if job deletion fails', async () => {
    const item = fixture();
    await db.items.add(item);
    await db.jobs.add(job(item.id));
    const fail = () => { throw new Error('job deletion failed'); };
    db.jobs.hook('deleting', fail);
    try {
      await expect(deleteItem(item.id)).rejects.toThrow('job deletion failed');
    } finally {
      db.jobs.hook('deleting').unsubscribe(fail);
    }
    expect(await db.items.get(item.id)).toEqual(item);
    expect(await db.jobs.get(item.id)).toEqual(job(item.id));
  });

  it('only accepts explicitly editable fields', async () => {
    const item = fixture();
    await db.items.add(item);
    await expect(updateItem(item.id, JSON.parse('{"notes":"ok","content":"overwrite"}'))).rejects.toThrow();
    expect(await db.items.get(item.id)).toEqual(item);
  });
});

describe('backup validation and atomic merge', () => {
  it('exports only the versioned items envelope and restores every field', async () => {
    const original = fixture();
    await db.items.add(original);
    await db.jobs.add(job(original.id));
    const exported = await exportBackup();
    expect(Object.keys(JSON.parse(exported)).sort()).toEqual(['exportedAt', 'items', 'schemaVersion']);
    expect(parseBackup(exported)).toEqual([original]);
    expect(exported).not.toContain('settingsRevision');
    expect(exported).not.toContain('apiKey');
    expect(exported).not.toContain('githubToken');
    await deleteItem(original.id);
    expect(await importBackup(exported)).toEqual({ added: 1, skipped: 0 });
    expect(await db.items.get(original.id)).toEqual(original);
    expect(await db.jobs.count()).toBe(0);
  });

  it('resets imported active analysis without scheduling jobs and preserves empty overrides', async () => {
    const items = ['pending', 'running'].map((status, index) => ({
      ...fixture(`pending-${index}`), analysisStatus: status, summaryOverride: '', tagsOverride: [], categoryOverride: '',
    }));
    await db.jobs.add(job(items[0]!.id));
    expect(await importBackup(backup(items))).toEqual({ added: 2, skipped: 0 });
    for (const item of await db.items.toArray()) {
      expect(item).toMatchObject({ analysisStatus: 'disabled', summaryOverride: '', tagsOverride: [], categoryOverride: '' });
      expect(item.analysisError).toBeUndefined();
      expect(item.ai).toEqual(fixture().ai);
    }
    expect(await db.jobs.count()).toBe(0);
  });

  it('skips conflicting ids, URLs, and within-file duplicates without overwriting notes or jobs', async () => {
    const original = fixture('local');
    await db.items.add(original);
    await db.jobs.add(job(original.id));
    const sameId = { ...fixture('different-url'), id: original.id, notes: 'overwrite' };
    const sameUrl = { ...original, id: 'different-id', notes: 'overwrite' };
    const added = fixture('new-item');
    expect(await importBackup(backup([sameId, sameUrl, added, added])))
      .toEqual({ added: 1, skipped: 3 });
    expect(await db.items.get(original.id)).toEqual(original);
    expect(await db.jobs.get(original.id)).toEqual(job(original.id));
    expect(await importBackup(backup([added]))).toEqual({ added: 0, skipped: 1 });
  });

  it.each([
    { url: 'javascript:alert(1)' }, { normalizedUrl: 'https://user:secret@example.com/' },
    { url: 'https://user:secret@github.com/example/restored' }, { normalizedUrl: 'https://example.com/unrelated' },
    { domain: 'evil.example' }, { content: 'x'.repeat(1000001) }, { notes: 'x'.repeat(100001) },
    { tags: ['ok', 42] }, { tags: Array(101).fill('tag') }, { truncated: 'false' },
    { contentVersion: 0 }, { contentVersion: 1.5 }, { createdAt: 'yesterday' },
    { analysisStatus: 'queued' }, { source: 'remote' }, { id: '__proto__' },
    { apiKey: 'credential' }, { github: { ...fixture().github, stars: -1 } },
    { ai: { ...fixture().ai, apiKey: 'credential' } }, { notes: 'bad\u0000text' },
    JSON.parse('{"__proto__":{"polluted":true}}'),
  ])('rejects an invalid later item before writing any valid item: %j', async (patch) => {
    const local = fixture('existing');
    await db.items.add(local);
    await expect(importBackup(backup([fixture('valid-first'), { ...fixture(), ...patch }]))).rejects.toThrow();
    expect(await db.items.toArray()).toEqual([local]);
    expect(await db.jobs.count()).toBe(0);
  });

  it('rejects malformed, unsupported, unknown-field, or incomplete envelopes', () => {
    for (const value of [
      '{', '[]', 'null', backup([], { schemaVersion: 2 }), backup([], { exportedAt: 'invalid' }),
      backup([], { settings: { apiKey: 'secret' } }), backup([{ id: 'partial' }]),
      '{"schemaVersion":1,"exportedAt":"2026-09-22T10:00:00.000Z","items":[],"__proto__":{}}',
    ]) expect(() => parseBackup(value)).toThrow();
  });

  it('rolls back all writes when IndexedDB fails after the first imported item', async () => {
    const fail = (_key: unknown, item: Item) => {
      if (item.id === 'second') throw new Error('storage failure');
    };
    db.items.hook('creating', fail);
    try {
      await expect(importBackup(backup([fixture('first'), fixture('second')]))).rejects.toThrow('storage failure');
    } finally {
      db.items.hook('creating').unsubscribe(fail);
    }
    expect(await db.items.count()).toBe(0);
  });
});

describe('display values', () => {
  it('uses human overrides, then AI, then source text, with explicit empty values preserved', () => {
    const item = fixture();
    expect(displaySummary(item)).toBe('人工摘要');
    expect(displayTags(item)).toEqual(['手工标签']);
    expect(displayCategory(item)).toBe('人工分类');
    delete item.summaryOverride;
    delete item.tagsOverride;
    delete item.categoryOverride;
    expect(displaySummary(item)).toBe('模型摘要');
    expect(displayTags(item)).toEqual(['来源标签', '模型标签']);
    expect(displayCategory(item)).toBe('模型分类');
    delete item.ai;
    expect(displaySummary(item)).toBe('来源简介');
    expect(displayCategory(item)).toBe('来源分类');
    item.description = '';
    expect(displaySummary(item)).toBe('原始摘录');
  });
});
