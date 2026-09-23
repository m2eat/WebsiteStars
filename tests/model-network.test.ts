import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ModelNetworkCommand, ModelNetworkEvent } from '../lib/model-network-protocol';

interface TestWorker {
  onmessage?: (event: { data: ModelNetworkEvent }) => void;
  terminate: ReturnType<typeof vi.fn>;
}
const state = vi.hoisted(() => ({ connect: vi.fn(), worker: undefined as TestWorker | undefined }));
vi.mock('wxt/browser', () => ({ browser: { runtime: { connect: state.connect } } }));
vi.mock('../entrypoints/model-network/network-worker?worker', () => ({ default: class {
  postMessage = vi.fn(); terminate = vi.fn(); onmessage?: (event: { data: ModelNetworkEvent }) => void; onerror?: () => void;
  constructor() { state.worker = this; }
} }));
function event<T>() {
  const listeners = new Set<(value: T) => void>();
  return { addListener: (listener: (value: T) => void) => listeners.add(listener), emit: (value: T) => { for (const listener of listeners) listener(value); } };
}
const command = (id: string): ModelNetworkCommand => ({ type: 'fetch', id, url: 'http://127.0.0.1:9000/model', method: 'POST', headers: [], body: [123, 125] });
beforeEach(() => { vi.resetModules(); vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval'] }); });
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });

describe('offscreen document lifetime', () => {
  it('sends keepalive only during active requests and terminates its worker on background disconnect', async () => {
    const port = { onMessage: event<ModelNetworkCommand>(), onDisconnect: event<void>(), postMessage: vi.fn(), disconnect: vi.fn() };
    state.connect.mockReturnValue(port);
    await import('../entrypoints/model-network/main');
    await vi.advanceTimersByTimeAsync(40000);
    expect(port.postMessage).not.toHaveBeenCalled();
    port.onMessage.emit(command('one'));
    port.onMessage.emit(command('two'));
    await vi.advanceTimersByTimeAsync(20000);
    expect(port.postMessage).toHaveBeenCalledExactlyOnceWith({ type: 'heartbeat' });
    port.onMessage.emit({ type: 'abort', id: 'one' });
    await vi.advanceTimersByTimeAsync(20000);
    expect(port.postMessage).toHaveBeenCalledTimes(2);
    state.worker!.onmessage!({ data: { type: 'end', id: 'two' } });
    port.postMessage.mockClear();
    await vi.advanceTimersByTimeAsync(40000);
    expect(port.postMessage).not.toHaveBeenCalled();
    port.onMessage.emit(command('three'));
    port.onDisconnect.emit();
    await vi.advanceTimersByTimeAsync(40000);
    expect(port.postMessage).not.toHaveBeenCalled();
    expect(state.worker!.terminate).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });
});

describe('dedicated network worker', () => {
  let worker: { onmessage?: (message: { data: ModelNetworkCommand }) => void; postMessage: ReturnType<typeof vi.fn> };
  beforeEach(async () => {
    worker = { postMessage: vi.fn() };
    vi.stubGlobal('self', worker);
    await import('../entrypoints/model-network/network-worker');
    expect(worker.postMessage).toHaveBeenCalledWith({ type: 'ready' });
  });

  it('fetches with redirects and cookies disabled and streams only on pull', async () => {
    const fetcher = vi.fn(async () => new Response('hello', { headers: { 'content-type': 'text/plain' } }));
    vi.stubGlobal('fetch', fetcher);
    worker.onmessage!({ data: command('one') });
    await vi.waitFor(() => expect(worker.postMessage).toHaveBeenCalledWith(expect.objectContaining({ type: 'headers', id: 'one', status: 200 })));
    expect(fetcher).toHaveBeenCalledWith('http://127.0.0.1:9000/model', expect.objectContaining({ method: 'POST', redirect: 'error', credentials: 'omit', signal: expect.any(AbortSignal) }));
    expect(worker.postMessage.mock.calls.some(([message]) => message.type === 'chunk')).toBe(false);
    worker.onmessage!({ data: { type: 'pull', id: 'one' } });
    await vi.waitFor(() => expect(worker.postMessage).toHaveBeenCalledWith({ type: 'chunk', id: 'one', bytes: [...new TextEncoder().encode('hello')] }));
    worker.onmessage!({ data: { type: 'pull', id: 'one' } });
    await vi.waitFor(() => expect(worker.postMessage).toHaveBeenCalledWith({ type: 'end', id: 'one' }));
    expect(vi.getTimerCount()).toBe(0);
  });

  it('isolates cancellation and bounds an orphaned request to the supported maximum', async () => {
    const signals: AbortSignal[] = [];
    vi.stubGlobal('fetch', vi.fn((_input: unknown, init: RequestInit) => {
      signals.push(init.signal!);
      return new Promise<Response>((_resolve, reject) => init.signal!.addEventListener('abort', () => reject(init.signal!.reason), { once: true }));
    }));
    worker.onmessage!({ data: command('one') });
    worker.onmessage!({ data: command('two') });
    worker.onmessage!({ data: { type: 'abort', id: 'one' } });
    expect(signals[0]!.aborted).toBe(true);
    expect(signals[1]!.aborted).toBe(false);
    await vi.advanceTimersByTimeAsync(1800_000);
    expect(signals[1]!.aborted).toBe(true);
    expect(worker.postMessage).toHaveBeenCalledWith({ type: 'error', id: 'two', timeout: true });
    expect(worker.postMessage).not.toHaveBeenCalledWith(expect.objectContaining({ type: 'error', id: 'one' }));
    expect(vi.getTimerCount()).toBe(0);
  });

  it('validates destinations inside the worker and sanitizes network failures', async () => {
    const fetcher = vi.fn(async () => { throw new Error('SECRET-AUTHORIZATION'); });
    vi.stubGlobal('fetch', fetcher);
    worker.onmessage!({ data: { ...command('unsafe'), type: 'fetch', url: 'http://remote.example/model', method: 'POST', headers: [] } });
    await vi.waitFor(() => expect(worker.postMessage).toHaveBeenCalledWith({ type: 'error', id: 'unsafe', timeout: false }));
    expect(fetcher).not.toHaveBeenCalled();
    worker.onmessage!({ data: command('failure') });
    await vi.waitFor(() => expect(worker.postMessage).toHaveBeenCalledWith({ type: 'error', id: 'failure', timeout: false }));
    expect(JSON.stringify(worker.postMessage.mock.calls)).not.toContain('SECRET-AUTHORIZATION');
    expect(vi.getTimerCount()).toBe(0);
  });
});
