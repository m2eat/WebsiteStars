import 'fake-indexeddb/auto';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { db, deleteItem, exportBackup, importBackup, saveCapture, updateItem } from '../lib/library';
import { DEFAULT_SETTINGS, type Settings } from '../lib/types';
const state = vi.hoisted(() => ({ settings: {} as Settings }));
vi.mock('wxt/browser', () => ({ browser: {
  storage: { local: {
    get: vi.fn(async () => ({ settings: structuredClone(state.settings) })),
    set: vi.fn(async ({ settings }: { settings: Settings }) => { state.settings = structuredClone(settings); }),
  } },
  permissions: { contains: vi.fn(async () => true) },
} }));
vi.mock('../lib/model-fetch', () => ({ modelFetch: (input: RequestInfo | URL, init?: RequestInit) => fetch(input, init) }));
vi.mock('../lib/analysis', async importOriginal => {
  const original = await importOriginal<typeof import('../lib/analysis')>();
  return { ...original, drainQueue: vi.fn(async () => undefined) };
});
import { queueGithubRefresh } from '../lib/analysis';
import { savePage, saveUrl } from '../lib/capture';
import { saveSettings } from '../lib/settings';
const { drainQueue, cancelAnalyses, queueAnalysis } = await vi.importActual<typeof import('../lib/analysis')>('../lib/analysis');

const metadata = () => Response.json({ id: 7, private: false, description: 'source', language: 'TypeScript', topics: [], stargazers_count: 5 });
const readme = () => Response.json({ encoding: 'base64', content: btoa('README CONTENT') });
const model = () => Response.json({ choices: [{ message: { content: JSON.stringify({ summary: 'summary', category: '', tags: [], keywords: [] }) } }] });
function requests() {
  return vi.fn(async (url: unknown) => String(url).startsWith('https://api.github.com/')
    ? String(url).endsWith('/readme') ? readme() : metadata() : model());
}

beforeEach(async () => {
  await db.items.clear(); await db.jobs.clear();
  state.settings = { ...DEFAULT_SETTINGS };
  vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('offline'); }));
});
afterEach(async () => {
  await cancelAnalyses();
  await drainQueue();
  await db.jobs.clear();
  vi.unstubAllGlobals();
});

it('deduplicates GitHub variants but preserves issue pages as articles', async () => {
  const first = await saveUrl('Owner/Repo');
  const next = await saveUrl('https://github.com/owner/repo/tree/main');
  const readmeItem = await saveUrl('https://github.com/OWNER/REPO/blob/main/README.md');
  const issue = await saveUrl('https://github.com/owner/repo/issues/1');
  expect(next.item.id).toBe(first.item.id);
  expect(readmeItem.created).toBe(false);
  expect(issue.item.source).toBe('article');
  expect(await db.items.count()).toBe(2);
  expect(await db.jobs.count()).toBe(1);
});

it('fills missing content while keeping user edits, then retains existing snapshots', async () => {
  const first = await saveUrl('https://example.com/docs/guide', '我的标题');
  await updateItem(first.item.id, { notes: '私人想法', tagsOverride: ['人工标签'] });
  const captured = await savePage({ url: first.item.url, title: '网页标题', content: '正文内容', source: 'docs', description: '来源简介' });
  expect(captured.created).toBe(false);
  expect(captured.item).toMatchObject({ title: '我的标题', notes: '私人想法', tagsOverride: ['人工标签'], content: '正文内容', source: 'docs' });
  await savePage({ url: first.item.url, content: '后来的不同正文' });
  expect((await db.items.get(first.item.id))?.content).toBe('正文内容');
});

it('allows local capture on blocked domains and retains only excerpts and selections when requested', async () => {
  state.settings = { ...DEFAULT_SETTINGS, aiEnabled: true, blockedDomains: ['example.com'], retainContent: false };
  const result = await savePage({ url: 'https://private.example.com./article', content: '全文', excerpt: '摘录', selection: '划词' });
  expect(result.item.content).toBe('');
  expect(result.item.excerpt).toBe('摘录');
  expect(result.item.selections).toEqual(['划词']);
  expect(await db.jobs.count()).toBe(0);
});

it('commits follow-up intent before returning and recovers it after database reopening', async () => {
  state.settings = { ...DEFAULT_SETTINGS, aiEnabled: true, apiKey: 'test-key' };
  const fetcher = requests(); vi.stubGlobal('fetch', fetcher);
  const { item } = await saveUrl('owner/repo');
  expect(fetcher).not.toHaveBeenCalled();
  expect(await db.jobs.get(item.id)).toMatchObject({ kind: 'github', analyzeAfter: true, status: 'pending', attempts: 0 });
  db.close(); await db.open();
  await drainQueue();
  expect((await db.items.get(item.id))).toMatchObject({ content: 'README CONTENT', githubVisibility: 'public', analysisStatus: 'succeeded' });
  expect(fetcher).toHaveBeenCalledTimes(3);
  expect(await db.jobs.count()).toBe(0);
});

it('rolls back capture if its durable follow-up cannot be saved', async () => {
  const fail = () => { throw new Error('job write failed'); };
  db.jobs.hook('creating', fail);
  try { await expect(saveUrl('owner/repo')).rejects.toThrow('job write failed'); }
  finally { db.jobs.hook('creating').unsubscribe(fail); }
  expect(await db.items.count()).toBe(0);
});

it('persists article analysis intent before returning as well', async () => {
  state.settings = { ...DEFAULT_SETTINGS, aiEnabled: true, apiKey: 'test-key' };
  const { item } = await saveUrl('https://example.com/article');
  expect(await db.jobs.get(item.id)).toMatchObject({ kind: 'analysis', contentVersion: 1 });
});

it.each([403, 404, 429, 'network'] as const)('preserves snapshots when README fails with %s', async failure => {
  const original = await saveCapture({ url: 'https://github.com/owner/repo', content: 'ORIGINAL', excerpt: 'EXCERPT', truncated: true });
  await queueGithubRefresh(original.item.id);
  vi.stubGlobal('fetch', vi.fn(async (url: unknown) => {
    if (!String(url).endsWith('/readme')) return metadata();
    if (failure === 'network') throw new TypeError('network error');
    return new Response('', { status: failure });
  }));
  await drainQueue();
  expect(await db.items.get(original.item.id)).toMatchObject({ content: 'ORIGINAL', excerpt: 'EXCERPT', truncated: true, github: { stars: 5 } });
  expect(await db.jobs.count()).toBe(0);
});

it('rejects automatic and manual AI after identifying a private repository, including after restore', async () => {
  state.settings = { ...DEFAULT_SETTINGS, aiEnabled: true, apiKey: 'test-key' };
  const fetcher = vi.fn(async () => Response.json({ private: true }));
  vi.stubGlobal('fetch', fetcher);
  const { item } = await savePage({ url: 'https://github.com/owner/private', content: 'PRIVATE CONTENT' });
  await drainQueue();
  expect(fetcher).toHaveBeenCalledTimes(1);
  expect(String(fetcher.mock.calls[0])).not.toContain('chat/completions');
  expect(await db.items.get(item.id)).toMatchObject({ content: 'PRIVATE CONTENT', githubVisibility: 'private', analysisStatus: 'disabled' });
  await expect(queueAnalysis(item.id)).rejects.toThrow('私有');
  const backup = await exportBackup();
  await deleteItem(item.id); await importBackup(backup);
  await expect(queueAnalysis(item.id)).rejects.toThrow('私有');
  expect(fetcher).toHaveBeenCalledTimes(1);
  expect(await db.jobs.count()).toBe(0);
});

it('rechecks visibility before manually analyzing an unverified repository', async () => {
  state.settings = { ...DEFAULT_SETTINGS, aiEnabled: true, apiKey: 'test-key' };
  const fetcher = vi.fn(async () => Response.json({ private: true })); vi.stubGlobal('fetch', fetcher);
  const { item } = await saveCapture({ url: 'https://github.com/owner/private', content: 'PRIVATE CONTENT' });
  await queueAnalysis(item.id); await drainQueue();
  expect(fetcher).toHaveBeenCalledTimes(1);
  expect((await db.items.get(item.id))?.githubVisibility).toBe('private');
});

it('does not send repository content to AI when visibility verification fails', async () => {
  state.settings = { ...DEFAULT_SETTINGS, aiEnabled: true, apiKey: 'test-key' };
  const fetcher = vi.fn(async () => new Response('', { status: 404 })); vi.stubGlobal('fetch', fetcher);
  const { item } = await savePage({ url: 'https://github.com/owner/unknown', content: 'PAGE CONTENT' });
  await drainQueue();
  expect(fetcher).toHaveBeenCalledTimes(1);
  expect(await db.jobs.get(item.id)).toMatchObject({ kind: 'github', status: 'pending', attempts: 1 });
  expect((await db.items.get(item.id))?.ai).toBeUndefined();
});

it('uses new retention settings for a delayed README and cancels only its AI handoff', async () => {
  state.settings = { ...DEFAULT_SETTINGS, aiEnabled: true, apiKey: 'test-key' };
  let finish!: (response: Response) => void;
  const fetcher = vi.fn(async (url: unknown) => String(url).endsWith('/readme')
    ? new Promise<Response>(resolve => { finish = resolve; }) : metadata());
  vi.stubGlobal('fetch', fetcher);
  const { item } = await saveUrl('owner/repo');
  const running = drainQueue();
  await vi.waitFor(() => expect(finish).toBeTypeOf('function'));
  await saveSettings({ ...state.settings, retainContent: false });
  await cancelAnalyses();
  expect(await db.jobs.get(item.id)).toMatchObject({ kind: 'github', analyzeAfter: false });
  finish(readme()); await running;
  expect(await db.items.get(item.id)).toMatchObject({ content: '', truncated: false, github: { stars: 5 }, analysisStatus: 'disabled' });
  expect(fetcher).toHaveBeenCalledTimes(2);
  expect(await db.jobs.count()).toBe(0);
});

it('does not resurrect an item or schedule AI after deletion during enrichment', async () => {
  state.settings = { ...DEFAULT_SETTINGS, aiEnabled: true, apiKey: 'test-key' };
  let finish!: (response: Response) => void;
  const fetcher = vi.fn(async (url: unknown) => String(url).endsWith('/readme')
    ? new Promise<Response>(resolve => { finish = resolve; }) : metadata());
  vi.stubGlobal('fetch', fetcher);
  const { item } = await saveUrl('owner/repo');
  const running = drainQueue();
  await vi.waitFor(() => expect(finish).toBeTypeOf('function'));
  await deleteItem(item.id);
  finish(readme()); await running;
  expect(await db.items.get(item.id)).toBeUndefined();
  expect(await db.jobs.count()).toBe(0);
  expect(fetcher).toHaveBeenCalledTimes(2);
});

it('restores pending captures without restoring task intent or making requests', async () => {
  state.settings = { ...DEFAULT_SETTINGS, aiEnabled: true, apiKey: 'test-key' };
  const { item } = await saveUrl('owner/repo');
  const backup = await exportBackup();
  await deleteItem(item.id);
  await importBackup(backup);
  const fetcher = requests(); vi.stubGlobal('fetch', fetcher);
  await drainQueue();
  expect(fetcher).not.toHaveBeenCalled();
  expect(await db.jobs.count()).toBe(0);
  expect((await db.items.get(item.id))?.analysisStatus).toBe('disabled');
});


it('reclaims an expired GitHub lease after restart without enabling AI', async () => {
  const { item } = await saveUrl('owner/repo');
  await db.jobs.update(item.id, { status: 'running', attempts: 1, leaseUntil: 0, leaseId: 'terminated-worker' });
  db.close(); await db.open();
  const fetcher = requests(); vi.stubGlobal('fetch', fetcher);
  await drainQueue();
  expect(fetcher).toHaveBeenCalledTimes(2);
  expect(await db.items.get(item.id)).toMatchObject({ content: 'README CONTENT', githubVisibility: 'public', analysisStatus: 'disabled' });
  expect(await db.jobs.count()).toBe(0);
});

it('never sends content for a domain blocked while GitHub enrichment is in progress', async () => {
  state.settings = { ...DEFAULT_SETTINGS, aiEnabled: true, apiKey: 'test-key' };
  let finish!: (response: Response) => void;
  const fetcher = vi.fn(async (url: unknown) => String(url).endsWith('/readme')
    ? new Promise<Response>(resolve => { finish = resolve; }) : metadata());
  vi.stubGlobal('fetch', fetcher);
  const { item } = await saveUrl('owner/repo');
  const running = drainQueue();
  await vi.waitFor(() => expect(finish).toBeTypeOf('function'));
  await saveSettings({ ...state.settings, blockedDomains: ['github.com.'] });
  finish(readme()); await running;
  expect(fetcher).toHaveBeenCalledTimes(2);
  expect((await db.items.get(item.id))?.analysisStatus).toBe('disabled');
  await expect(queueAnalysis(item.id)).rejects.toThrow('禁止');
  expect(await db.jobs.count()).toBe(0);
});
