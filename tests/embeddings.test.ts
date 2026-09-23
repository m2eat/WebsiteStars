import { createHash } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { sha256 } from '../lib/chunking';
import { embedTexts, embeddingKey, semanticQuery } from '../lib/embeddings';
import { DEFAULT_SETTINGS, type Settings } from '../lib/types';

const mocks = vi.hoisted(() => ({ fetch: vi.fn(), permission: true }));
vi.mock('../lib/model-fetch', () => ({ modelFetch: mocks.fetch }));
vi.mock('wxt/browser', () => ({ browser: { permissions: { contains: vi.fn(async () => mocks.permission) } } }));
const settings = (patch: Partial<Settings> = {}): Settings => ({ ...DEFAULT_SETTINGS,
  semanticEnabled: true, embeddingEndpoint: 'https://vectors.example/v1', embeddingModel: 'multilingual-model',
  embeddingApiKey: 'EMBEDDING_SECRET', ...patch });
const response = (vectors: number[][]) => Response.json({ data: vectors.map((embedding, index) => ({ embedding, index })) });
beforeEach(() => { mocks.fetch.mockReset(); mocks.permission = true; });
afterEach(() => { vi.useRealTimers(); });

describe('embedding configuration and transport', () => {
  it.each(['', 'abc', '中文索引😀', 'a'.repeat(1000)])('uses standard SHA-256 for %j', text => {
    expect(sha256(text)).toBe(createHash('sha256').update(text).digest('hex'));
  });

  it('hashes endpoint and model, normalizes endpoint suffixes, and excludes all credentials', () => {
    const key = embeddingKey(settings());
    expect(key).toMatch(/^embedding-v1:[a-f0-9]{64}$/u);
    expect(embeddingKey(settings({ embeddingApiKey: 'NEW_SECRET', apiKey: 'CHAT_SECRET' }))).toBe(key);
    expect(embeddingKey(settings({ embeddingEndpoint: 'https://vectors.example/v1/embeddings/' }))).toBe(key);
    expect(embeddingKey(settings({ embeddingModel: 'another-model' }))).not.toBe(key);
    expect(embeddingKey(settings({ embeddingEndpoint: 'https://other.example/v1' }))).not.toBe(key);
    expect(key).not.toMatch(/SECRET|vectors.example|multilingual-model/u);
  });

  it('uses only the explicit embedding connection and offscreen fetch, deduplicating inputs', async () => {
    mocks.fetch.mockResolvedValue(Response.json({ data: [
      { index: 1, embedding: [0, 1] }, { index: 0, embedding: [1, 0] },
    ] }));
    expect(await embedTexts(['hello', '你好', 'hello'], settings())).toEqual([[1, 0], [0, 1], [1, 0]]);
    const [url, init] = mocks.fetch.mock.calls[0]!;
    expect(url).toBe('https://vectors.example/v1/embeddings');
    expect(JSON.parse(init.body)).toEqual({ model: 'multilingual-model', input: ['hello', '你好'], encoding_format: 'float' });
    expect(init.headers).toEqual({ 'Content-Type': 'application/json', Authorization: 'Bearer EMBEDDING_SECRET' });
    expect(init).toMatchObject({ redirect: 'error', credentials: 'omit', signal: expect.any(AbortSignal) });
  });

  it.each(['http://localhost:8080/v1', 'http://127.0.0.1:8080', 'http://[::1]:8080/v1'])('supports keyless loopback %s', async address => {
    mocks.fetch.mockResolvedValue(response([[1, 2]]));
    await embedTexts(['query'], settings({ embeddingEndpoint: address, embeddingApiKey: '' }));
    expect(mocks.fetch.mock.calls[0]![1].headers).toEqual({ 'Content-Type': 'application/json' });
  });

  it.each(['', 'http://remote.example/v1', 'https://user:SECRET@vectors.example', 'https://vectors.example?key=SECRET', 'https://vectors.example/#secret', 'file:///tmp/model'])('rejects unsafe or absent endpoint %s without fallback', async address => {
    await expect(embedTexts(['query'], settings({ embeddingEndpoint: address }))).rejects.toThrow();
    expect(mocks.fetch).not.toHaveBeenCalled();
  });

  it('checks host permission and never silently starts semantic queries without consent', async () => {
    mocks.permission = false;
    await expect(embedTexts(['query'], settings())).rejects.toThrow('授权');
    await expect(semanticQuery('query', settings({ semanticEnabled: false }))).rejects.toThrow('启用');
    expect(mocks.fetch).not.toHaveBeenCalled();
  });

  it('bounds batches to sixteen and keeps result ordering across batches', async () => {
    mocks.fetch.mockImplementation(async (_url, init) => response(JSON.parse(init.body).input.map((text: string) => [Number(text), 1])));
    const input = Array.from({ length: 35 }, (_, i) => String(i));
    expect(await embedTexts(input, settings())).toEqual(input.map(text => [Number(text), 1]));
    expect(mocks.fetch.mock.calls.map(([, init]) => JSON.parse(init.body).input.length)).toEqual([16, 16, 3]);
    expect(await semanticQuery('3', settings())).toEqual([3, 1]);
  });

  it('propagates cancellation to the offscreen request and does not launch later batches', async () => {
    const abort = new AbortController();
    let received: AbortSignal | undefined;
    mocks.fetch.mockImplementation(async (_url, init) => {
      received = init.signal;
      abort.abort();
      throw new Error('SECRET transport aborted');
    });
    await expect(embedTexts(Array.from({ length: 20 }, (_, i) => String(i)), settings(), abort.signal))
      .rejects.toMatchObject({ name: 'AbortError' });
    expect(received?.aborted).toBe(true);
    expect(mocks.fetch).toHaveBeenCalledTimes(1);
    await expect(embedTexts(['query'], settings(), abort.signal)).rejects.toMatchObject({ name: 'AbortError' });
    expect(mocks.fetch).toHaveBeenCalledTimes(1);
  });

  it('uses the configured model timeout and sanitizes the timeout error', async () => {
    vi.useFakeTimers();
    mocks.fetch.mockImplementation((_url, init) => new Promise((_resolve, reject) => {
      init.signal.addEventListener('abort', () => reject(new Error('SECRET timeout')), { once: true });
    }));
    const result = embedTexts(['query'], settings({ modelTimeoutSeconds: 30 }));
    const assertion = expect(result).rejects.toMatchObject({ name: 'TimeoutError', message: 'Embedding 请求超时。' });
    await vi.advanceTimersByTimeAsync(30000);
    await assertion;
  });
});

describe('embedding response limits', () => {
  it.each([
    {}, { data: [] }, { data: [{ index: 0, embedding: [] }] },
    { data: [{ index: 0, embedding: [null] }] }, { data: [{ index: 0, embedding: ['1'] }] },
    { data: [{ index: 1, embedding: [1] }] }, { data: [{ index: 0, embedding: Array(4097).fill(1) }] },
  ])('rejects invalid output %j', async body => {
    mocks.fetch.mockResolvedValue(Response.json(body));
    await expect(embedTexts(['query'], settings())).rejects.toThrow('格式');
  });

  it('rejects duplicate indexes, inconsistent dimensions and non-finite numeric JSON', async () => {
    mocks.fetch.mockResolvedValueOnce(Response.json({ data: [{ index: 0, embedding: [1] }, { index: 0, embedding: [2] }] }));
    await expect(embedTexts(['one', 'two'], settings())).rejects.toThrow('格式');
    mocks.fetch.mockResolvedValueOnce(response([[1], [1, 2]]));
    await expect(embedTexts(['one', 'two'], settings())).rejects.toThrow('维度');
    mocks.fetch.mockResolvedValueOnce(new Response('{"data":[{"index":0,"embedding":[1e999]}]}'));
    await expect(embedTexts(['one'], settings())).rejects.toThrow('格式');
  });

  it('checks dimension consistency across batches', async () => {
    mocks.fetch.mockResolvedValueOnce(response(Array.from({ length: 16 }, () => [1, 0])))
      .mockResolvedValueOnce(response([[1, 0, 0]]));
    await expect(embedTexts(Array.from({ length: 17 }, (_, i) => String(i)), settings())).rejects.toThrow('维度');
  });

  it('caps streamed response bytes even without a content-length header', async () => {
    mocks.fetch.mockResolvedValue(new Response(' '.repeat(4 * 1024 * 1024 + 1)));
    await expect(embedTexts(['one'], settings())).rejects.toThrow('响应过大');
  });

  it('caps total response bytes across multiple bounded requests', async () => {
    mocks.fetch.mockImplementation(async (_url, init) => Response.json({
      padding: ' '.repeat(2 * 1024 * 1024),
      data: JSON.parse(init.body).input.map((_text: string, index: number) => ({ index, embedding: [1] })),
    }));
    await expect(embedTexts(Array.from({ length: 144 }, (_, i) => String(i)), settings())).rejects.toThrow('响应过大');
    expect(mocks.fetch.mock.calls.length).toBeLessThan(9);
  });

  it('bounds inputs before contacting a service', async () => {
    for (const input of [[''], ['a'.repeat(8001)], Array(257).fill('a'), Array(40).fill('a'.repeat(8000))]) {
      await expect(embedTexts(input, settings())).rejects.toThrow('输入');
    }
    expect(mocks.fetch).not.toHaveBeenCalled();
    expect(await embedTexts([], settings())).toEqual([]);
  });

  it('does not expose HTTP bodies, credentials or raw network failures', async () => {
    mocks.fetch.mockResolvedValueOnce(new Response('SECRET internal error', { status: 401 }));
    await expect(embedTexts(['one'], settings())).rejects.toThrow('Embedding 授权失败');
    mocks.fetch.mockRejectedValueOnce(new Error('SECRET https://private-token.example'));
    await expect(embedTexts(['one'], settings())).rejects.toThrow('无法连接 Embedding 接口或响应格式无效，请检查设置后重试。');
  });
});
