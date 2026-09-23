import 'fake-indexeddb/auto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { db, deleteItem, enrichItem, exportBackup, saveCapture, updateItem } from '../lib/library';
import { DEFAULT_SETTINGS } from '../lib/types';

const state = vi.hoisted(() => ({ settings: {} as Record<string, unknown>, granted: true }));
vi.mock('wxt/browser', () => ({ browser: {
  storage: { local: { get: vi.fn(async () => ({ settings: state.settings })), set: vi.fn(async (value: { settings: Record<string, unknown> }) => { state.settings = value.settings; }) } },
  permissions: { contains: vi.fn(async () => state.granted) },
} }));
vi.mock('../lib/model-fetch', () => ({ modelFetch: (input: RequestInfo | URL, init?: RequestInit) => fetch(input, init) }));
import { cancelAnalyses, drainQueue, queueAnalysis } from '../lib/analysis';
import { endpointOrigin, saveSettings } from '../lib/settings';

const answer = { summary: '轻量终端 UI', category: '开发工具', tags: ['终端'], keywords: ['命令行'], stack: ['TypeScript'], useCases: ['交互命令行'] };
const response = () => Response.json({ choices: [{ message: { content: JSON.stringify(answer) } }] });

beforeEach(async () => {
  await db.items.clear(); await db.jobs.clear();
  state.settings = { ...DEFAULT_SETTINGS, aiEnabled: true, apiKey: 'test-only-token', revision: 1 };
  state.granted = true;
});
afterEach(async () => { await cancelAnalyses(); await drainQueue(); vi.useRealTimers(); vi.unstubAllGlobals(); });

describe('optional AI pipeline', () => {
  it.each([['en-US', 'English'], ['zh-CN', 'Simplified Chinese']])('requests new summaries in browser language %s', async (language, expected) => {
    vi.stubGlobal('navigator', { language, languages: [language] });
    const fetcher = vi.fn(async (_url: unknown, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body));
      expect(body.messages[0].content).toContain(`JSON object in ${expected}`);
      expect(body.messages[1].content).toContain('原始标题 remains unchanged');
      return response();
    });
    vi.stubGlobal('fetch', fetcher);
    const { item } = await saveCapture({ url: 'https://example.com/locale-analysis', title: '原始标题 remains unchanged', content: 'source text' });
    await queueAnalysis(item.id); await drainQueue();
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect((await db.items.get(item.id))?.title).toBe('原始标题 remains unchanged');
  });
  it('sends source content only and preserves manual edits', async () => {
    const fetcher = vi.fn(async (_url: unknown, init?: RequestInit) => {
      expect(String(init?.body)).not.toContain('PRIVATE-NOTE');
      expect(String(init?.body)).not.toContain('私人摘录');
      return response();
    });
    vi.stubGlobal('fetch', fetcher);
    const { item } = await saveCapture({ url: 'https://example.com/cli', title: 'CLI', content: 'terminal rendering', selection: '私人摘录' });
    await updateItem(item.id, { notes: 'PRIVATE-NOTE', summaryOverride: '人工简介', tagsOverride: ['自定义'] });
    await queueAnalysis(item.id); await drainQueue();
    const saved = await db.items.get(item.id);
    expect(saved?.analysisStatus).toBe('succeeded');
    expect(saved?.summaryOverride).toBe('人工简介');
    expect(saved?.tagsOverride).toEqual(['自定义']);
    expect(saved?.ai?.summary).toBe(answer.summary);
    expect(await db.jobs.count()).toBe(0);
  });

  it('retains the saved item and durable retry when a provider fails', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('', { status: 429 })));
    const { item } = await saveCapture({ url: 'https://example.com/retry', content: 'hello' });
    await queueAnalysis(item.id); await drainQueue();
    expect((await db.items.get(item.id))?.analysisStatus).toBe('pending');
    const job = await db.jobs.get(item.id);
    expect(job?.attempts).toBe(1);
    expect(job?.nextAttempt).toBeGreaterThan(Date.now());
    await db.jobs.update(item.id, { status: 'running', leaseUntil: 0, nextAttempt: 0 });
    vi.stubGlobal('fetch', vi.fn(async () => response()));
    await drainQueue();
    expect((await db.items.get(item.id))?.analysisStatus).toBe('succeeded');
  });

  it('does not resurrect a deleted item after a delayed response', async () => {
    let finish!: (value: Response) => void;
    vi.stubGlobal('fetch', vi.fn(() => new Promise<Response>(resolve => { finish = resolve; })));
    const { item } = await saveCapture({ url: 'https://example.com/deleted', content: 'hello' });
    await queueAnalysis(item.id);
    await vi.waitFor(() => expect(finish).toBeTypeOf('function'));
    await deleteItem(item.id); finish(response()); await drainQueue();
    expect(await db.items.get(item.id)).toBeUndefined();
    expect(await db.jobs.count()).toBe(0);
  });

  it('discards responses after settings change or AI is disabled', async () => {
    let finish!: (value: Response) => void;
    vi.stubGlobal('fetch', vi.fn(() => new Promise<Response>(resolve => { finish = resolve; })));
    const { item } = await saveCapture({ url: 'https://example.com/cancel', content: 'hello' });
    await queueAnalysis(item.id);
    await vi.waitFor(() => expect(finish).toBeTypeOf('function'));
    state.settings = { ...state.settings, aiEnabled: false, revision: 2 };
    await cancelAnalyses(); finish(response()); await drainQueue();
    expect((await db.items.get(item.id))?.ai).toBeUndefined();
    expect((await db.items.get(item.id))?.analysisStatus).toBe('disabled');
  });

  it('requires explicit settings, secure endpoints and granted host permission', async () => {
    expect(() => endpointOrigin({ ...DEFAULT_SETTINGS, endpoint: 'http://remote.example/v1' })).toThrow();
    expect(() => endpointOrigin({ ...DEFAULT_SETTINGS, endpoint: 'https://user:password@example.com/v1' })).toThrow();
    expect(endpointOrigin({ ...DEFAULT_SETTINGS, endpoint: 'http://127.0.0.1:9000/v1' })).toBe('http://127.0.0.1:9000');
    state.granted = false;
    await expect(saveSettings({ ...DEFAULT_SETTINGS, aiEnabled: true, apiKey: 'test' })).rejects.toThrow('授权');
    state.settings = { ...DEFAULT_SETTINGS };
    await expect(queueAnalysis('missing')).rejects.toThrow('启用');
  });
});


describe('durable analysis regressions', () => {
  it.each(['analysis', 'github'] as const)('never dispatches an exhausted recovered %s job', async kind => {
    const fetcher = vi.fn(async () => response()); vi.stubGlobal('fetch', fetcher);
    const { item } = await saveCapture({ url: 'https://example.com/exhausted', content: 'body' });
    await db.jobs.put({ itemId: item.id, kind, contentVersion: 1, settingsRevision: 1, status: 'running', attempts: 3, nextAttempt: 0, leaseUntil: 0 });
    await drainQueue();
    expect(fetcher).not.toHaveBeenCalled();
    expect(await db.jobs.count()).toBe(0);
    expect(await db.items.get(item.id)).toMatchObject({ analysisStatus: 'failed', analysisError: expect.stringContaining('最大') });
  });

  it.each([
    { summary: '\u0000bad' }, { category: 'bad\u000b' }, { tags: ['bad\u001f'] },
    { keywords: ['bad\u0007'] }, { stack: ['bad\u007f'] }, { useCases: ['bad\u0001'] },
  ])('rejects incompatible AI output without breaking backup or manual edits: %j', async invalid => {
    vi.stubGlobal('fetch', vi.fn(async () => Response.json({ choices: [{ message: { content: JSON.stringify({ ...answer, ...invalid }) } }] })));
    const { item } = await saveCapture({ url: 'https://example.com/invalid-ai', content: 'body' });
    await queueAnalysis(item.id); await drainQueue();
    expect((await db.items.get(item.id))?.ai).toBeUndefined();
    expect((await db.items.get(item.id))?.analysisStatus).not.toBe('succeeded');
    await expect(exportBackup()).resolves.toContain(item.id);
    await expect(updateItem(item.id, { notes: 'still editable' })).resolves.toMatchObject({ notes: 'still editable' });
  });

  it('drops a successful response for an obsolete content version and retires its job', async () => {
    let finish!: (value: Response) => void;
    vi.stubGlobal('fetch', vi.fn(() => new Promise<Response>(resolve => { finish = resolve; })));
    const { item } = await saveCapture({ url: 'https://example.com/obsolete', content: 'first version' });
    await queueAnalysis(item.id);
    await vi.waitFor(() => expect(finish).toBeTypeOf('function'));
    await enrichItem(item.id, { url: item.url, content: 'second version' }, 1);
    finish(response()); await drainQueue();
    expect(await db.items.get(item.id)).toMatchObject({ contentVersion: 2, content: 'second version', analysisStatus: 'disabled' });
    expect((await db.items.get(item.id))?.ai).toBeUndefined();
    expect(await db.jobs.count()).toBe(0);
  });

  it('does not let a late response complete a replacement job with the same deadline', async () => {
    let finish!: (value: Response) => void;
    vi.stubGlobal('fetch', vi.fn(() => new Promise<Response>(resolve => { finish = resolve; })));
    const { item } = await saveCapture({ url: 'https://example.com/replaced', content: 'body' });
    await queueAnalysis(item.id);
    await vi.waitFor(() => expect(finish).toBeTypeOf('function'));
    const claimed = (await db.jobs.get(item.id))!;
    await db.jobs.put({ ...claimed, leaseId: 'new-owner', leaseUntil: Date.now() + 90000 });
    finish(response()); await drainQueue();
    expect((await db.items.get(item.id))?.ai).toBeUndefined();
    expect((await db.jobs.get(item.id))?.leaseId).toBe('new-owner');
  });
});


describe('configured analysis timeouts', () => {
  it('keeps the lease beyond a long request and aborts at the configured deadline', async () => {
    state.settings = { ...state.settings, modelTimeoutSeconds: 300 };
    const { item } = await saveCapture({ url: 'https://example.com/slow', content: 'body' });
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
    let networkSignal: AbortSignal | undefined;
    const fetcher = vi.fn((_input: unknown, init?: RequestInit) => {
      networkSignal = init?.signal ?? undefined;
      return new Promise<Response>((_resolve, reject) => networkSignal!.addEventListener('abort', () => reject(networkSignal!.reason), { once: true }));
    });
    vi.stubGlobal('fetch', fetcher);
    await queueAnalysis(item.id);
    await vi.waitFor(() => expect(fetcher).toHaveBeenCalledTimes(1));
    const claimed = (await db.jobs.get(item.id))!;
    expect(claimed.leaseUntil - Date.now()).toBeGreaterThan(300000);
    await vi.advanceTimersByTimeAsync(90001);
    expect(networkSignal?.aborted).toBe(false);
    expect((await db.jobs.get(item.id))!.leaseUntil).toBeGreaterThan(Date.now());
    expect(fetcher).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(210000);
    await drainQueue();
    expect(networkSignal?.aborted).toBe(true);
    expect(await db.jobs.get(item.id)).toMatchObject({ status: 'pending', attempts: 1, leaseUntil: 0 });
    expect((await db.items.get(item.id))?.analysisError).toContain('超时');
  });

  it('cancels a failed HTTP response body so the network worker does not retain the request', async () => {
    const cancel = vi.fn();
    vi.stubGlobal('fetch', vi.fn(async () => new Response(new ReadableStream({ cancel }), { status: 429 })));
    const { item } = await saveCapture({ url: 'https://example.com/error-body', content: 'body' });
    await queueAnalysis(item.id); await drainQueue();
    expect(cancel).toHaveBeenCalledTimes(1);
  });
});
