import { beforeEach, describe, expect, it, vi } from 'vitest';
import { listModels } from '../lib/models';
import { DEFAULT_SETTINGS, type ModelConnection } from '../lib/types';

const mocks = vi.hoisted(() => ({ fetch: vi.fn(), permission: true }));
vi.mock('../lib/model-fetch', () => ({ modelFetch: mocks.fetch }));
vi.mock('wxt/browser', () => ({ browser: { permissions: { contains: vi.fn(async () => mocks.permission) } } }));
const connection = (patch: Partial<ModelConnection> = {}): ModelConnection => ({ provider: 'compatible', endpoint: 'https://models.example/v1', apiKey: 'SECRET', accountId: '', modelTimeoutSeconds: DEFAULT_SETTINGS.modelTimeoutSeconds, ...patch });
beforeEach(() => { mocks.fetch.mockReset(); mocks.permission = true; });

describe('model discovery', () => {
  it('uses the draft endpoint, normalizes model IDs and only returns safe metadata', async () => {
    mocks.fetch.mockResolvedValue(Response.json({ data: [{ id: 'zeta' }, { id: 'alpha', name: 'Alpha' }, { id: 'alpha', name: 'Alpha' }, { id: '' }, { id: 123 }, { id: 'unsafe\nheader' }] }));
    const result = await listModels(connection({ endpoint: 'https://models.example/v1/' }));
    expect(result).toEqual({ models: [{ id: 'alpha', name: 'Alpha' }, { id: 'zeta', name: 'zeta' }], truncated: false });
    const [url, init] = mocks.fetch.mock.calls[0]!;
    expect(url).toBe('https://models.example/v1/models');
    expect(init.headers).toEqual({ Authorization: 'Bearer SECRET' });
    expect(init.body).toBeUndefined(); expect(init.redirect).toBe('error');
    expect(JSON.stringify(result)).not.toContain('SECRET');
  });
  it('supports keyless local endpoints and empty lists', async () => {
    mocks.fetch.mockResolvedValue(Response.json({ data: [] }));
    expect((await listModels(connection({ endpoint: 'http://127.0.0.1:1234/v1', apiKey: '' }))).models).toEqual([]);
    expect(mocks.fetch.mock.calls[0]![1].headers).toEqual({});
  });
  it('uses Cloudflare model names rather than internal IDs and follows bounded pagination', async () => {
    mocks.fetch.mockResolvedValueOnce(Response.json({ success: true, result: [{ id: 'internal-id', name: '@cf/test/first' }], result_info: { total_pages: 2 } })).mockResolvedValueOnce(Response.json({ success: true, result: [{ id: 'other-id', name: '@cf/test/second' }], result_info: { total_pages: 2 } }));
    const result = await listModels(connection({ provider: 'workers-ai', accountId: 'a'.repeat(32) }));
    expect(result.models.map(model => model.id)).toEqual(['@cf/test/first', '@cf/test/second']);
    expect(mocks.fetch.mock.calls[0]![0]).toContain('/ai/models/search?task=Text%20Generation&per_page=100&page=1');
    expect(mocks.fetch.mock.calls[1]![0]).toContain('page=2');
  });
  it.each([401, 403, 404, 405, 429, 500])('returns a helpful sanitized error for HTTP %i', async status => {
    mocks.fetch.mockResolvedValue(new Response('SECRET internal debug output', { status }));
    await expect(listModels(connection())).rejects.toThrow(/授权|接口|频繁|失败/);
    try { await listModels(connection()); } catch (error) { expect(String(error)).not.toContain('SECRET'); }
  });
  it.each([{}, { data: 'wrong' }, { success: false, data: [] }])('rejects malformed lists without hiding manual model entry: %j', async body => {
    mocks.fetch.mockResolvedValue(Response.json(body));
    await expect(listModels(connection())).rejects.toThrow('格式无效');
  });
  it('does not follow redirect or send credentials to an unapproved endpoint', async () => {
    mocks.permission = false;
    await expect(listModels(connection())).rejects.toThrow('授权');
    expect(mocks.fetch).not.toHaveBeenCalled();
    mocks.permission = true;
    await expect(listModels(connection({ endpoint: 'http://remote.example/v1' }))).rejects.toThrow('HTTPS');
    await expect(listModels(connection({ endpoint: 'https://secret:pass@models.example/v1' }))).rejects.toThrow();
    await expect(listModels(connection({ provider: 'workers-ai', accountId: 'bad' }))).rejects.toThrow('Account ID');
    expect(mocks.fetch).not.toHaveBeenCalled();
  });
  it('caps large lists and oversized responses', async () => {
    mocks.fetch.mockResolvedValueOnce(Response.json({ data: Array.from({ length: 1002 }, (_, i) => ({ id: `model-${i}` })) }));
    const result = await listModels(connection()); expect(result.models).toHaveLength(1000); expect(result.truncated).toBe(true);
    mocks.fetch.mockResolvedValueOnce(new Response(' '.repeat(2 * 1024 * 1024 + 1)));
    await expect(listModels(connection())).rejects.toThrow('响应过大');
  });
  it('hides raw network failures that may include credentials', async () => {
    mocks.fetch.mockRejectedValue(new Error('SECRET request failed'));
    await expect(listModels(connection())).rejects.toThrow('无法连接');
  });
});
