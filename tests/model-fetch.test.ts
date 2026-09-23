import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ModelNetworkCommand, ModelNetworkEvent } from '../lib/model-network-protocol';

const state = vi.hoisted(() => ({ connect: vi.fn(), create: vi.fn(), close: vi.fn(), contexts: vi.fn() }));
vi.mock('wxt/browser', () => ({ browser: {
  runtime: {
    id: 'test-extension', getURL: (path: string) => `chrome-extension://test-extension${path}`,
    onConnect: { addListener: state.connect }, getContexts: state.contexts,
  },
  offscreen: { Reason: { WORKERS: 'WORKERS' }, createDocument: state.create, closeDocument: state.close },
} }));

function event<T>() {
  const listeners = new Set<(value: T) => void>();
  return { addListener: (listener: (value: T) => void) => listeners.add(listener), emit: (value: T) => { for (const listener of listeners) listener(value); } };
}
function connection(url = 'chrome-extension://test-extension/model-network.html') {
  const port = {
    name: 'starts-model-network', sender: { id: 'test-extension', url },
    onMessage: event<ModelNetworkEvent>(), onDisconnect: event<void>(),
    postMessage: vi.fn<(command: ModelNetworkCommand) => void>(), disconnect: vi.fn(),
  };
  port.disconnect.mockImplementation(() => port.onDisconnect.emit());
  return port;
}
let port: ReturnType<typeof connection>;
let modelFetch: typeof import('../lib/model-fetch').modelFetch;
const fetchCommands = () => port.postMessage.mock.calls.map(([command]) => command).filter(command => command.type === 'fetch');
const headers = (id: string) => port.onMessage.emit({ type: 'headers', id, status: 200, statusText: 'OK', headers: [['content-type', 'text/plain']], body: true });

beforeEach(async () => {
  vi.resetModules();
  state.connect.mockReset(); state.create.mockReset(); state.close.mockReset(); state.contexts.mockReset();
  state.contexts.mockResolvedValue([]); state.close.mockResolvedValue(undefined);
  port = connection();
  state.create.mockImplementation(async () => {
    state.connect.mock.calls[0]![0](port);
    port.onMessage.emit({ type: 'ready' });
  });
  ({ modelFetch } = await import('../lib/model-fetch'));
});
afterEach(() => { port.onDisconnect.emit(); vi.useRealTimers(); vi.unstubAllGlobals(); });

describe('trusted offscreen model fetch broker', () => {
  it('serializes requests, starts a real WORKERS document and reconstructs streaming responses with backpressure', async () => {
    const nativeFetch = vi.fn(); vi.stubGlobal('fetch', nativeFetch);
    const pending = modelFetch('https://model.example/v1/chat/completions', {
      method: 'POST', headers: { Authorization: 'Bearer test-key' }, body: 'request body',
    });
    await vi.waitFor(() => expect(fetchCommands()).toHaveLength(1));
    const command = fetchCommands()[0]!;
    expect(command).toMatchObject({ method: 'POST', url: 'https://model.example/v1/chat/completions' });
    expect(command.headers).toContainEqual(['authorization', 'Bearer test-key']);
    expect(new TextDecoder().decode(Uint8Array.from(command.body!))).toBe('request body');
    expect(state.create).toHaveBeenCalledWith(expect.objectContaining({ url: '/model-network.html', reasons: ['WORKERS'] }));
    headers(command.id);
    const response = await pending;
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toBe('text/plain');
    expect(port.postMessage.mock.calls.filter(([message]) => message.type === 'pull')).toHaveLength(0);
    const reader = response.body!.getReader();
    const first = reader.read();
    await vi.waitFor(() => expect(port.postMessage).toHaveBeenCalledWith({ type: 'pull', id: command.id }));
    port.onMessage.emit({ type: 'chunk', id: command.id, bytes: [...new TextEncoder().encode('first')] });
    expect(new TextDecoder().decode((await first).value)).toBe('first');
    const last = reader.read();
    port.onMessage.emit({ type: 'end', id: command.id });
    expect((await last).done).toBe(true);
    expect(nativeFetch).not.toHaveBeenCalled();
  });

  it('cancels only the target request while sharing one document between concurrent calls', async () => {
    const controller = new AbortController();
    const first = modelFetch('https://model.example/one', { signal: controller.signal });
    const rejection = expect(first).rejects.toMatchObject({ name: 'AbortError' });
    const second = modelFetch('https://model.example/two');
    await vi.waitFor(() => expect(fetchCommands()).toHaveLength(2));
    const [one, two] = fetchCommands();
    controller.abort();
    await rejection;
    expect(port.postMessage).toHaveBeenCalledWith({ type: 'abort', id: one!.id });
    expect(port.postMessage).not.toHaveBeenCalledWith({ type: 'abort', id: two!.id });
    headers(two!.id);
    await (await second).body!.cancel();
    expect(port.postMessage).toHaveBeenCalledWith({ type: 'abort', id: two!.id });
    expect(state.create).toHaveBeenCalledTimes(1);
  });

  it('propagates abort through a response body after headers arrive and removes completed listeners', async () => {
    const controller = new AbortController();
    const pending = modelFetch('http://127.0.0.1:9000/model', { signal: controller.signal });
    await vi.waitFor(() => expect(fetchCommands()).toHaveLength(1));
    const { id } = fetchCommands()[0]!;
    headers(id);
    const text = (await pending).text();
    const rejected = expect(text).rejects.toMatchObject({ name: 'TimeoutError' });
    controller.abort(new DOMException('timed out', 'TimeoutError'));
    await rejected;
    expect(port.postMessage).toHaveBeenCalledWith({ type: 'abort', id });

    const completed = new AbortController();
    const response = modelFetch('https://model.example/done', { signal: completed.signal });
    await vi.waitFor(() => expect(fetchCommands()).toHaveLength(2));
    const doneId = fetchCommands()[1]!.id;
    port.onMessage.emit({ type: 'headers', id: doneId, status: 204, statusText: 'No Content', headers: [], body: false });
    port.onMessage.emit({ type: 'end', id: doneId });
    expect((await response).status).toBe(204);
    completed.abort();
    expect(port.postMessage).not.toHaveBeenCalledWith({ type: 'abort', id: doneId });
  });

  it('rejects disconnects and recreates a surviving document for the next request', async () => {
    const first = modelFetch('https://model.example/one');
    const rejection = expect(first).rejects.toThrow('中断');
    await vi.waitFor(() => expect(fetchCommands()).toHaveLength(1));
    port.onDisconnect.emit();
    await rejection;
    state.contexts.mockResolvedValue([{ contextType: 'OFFSCREEN_DOCUMENT' }]);
    port = connection();
    const retry = modelFetch('https://model.example/two');
    await vi.waitFor(() => expect(fetchCommands()).toHaveLength(1));
    expect(state.close).toHaveBeenCalledTimes(1);
    headers(fetchCommands()[0]!.id);
    await (await retry).body!.cancel();
  });

  it.each(['https://page.example/', 'chrome-extension://other-extension/model-network.html', 'chrome-extension://test-extension/options.html'])(
    'refuses network ports from %s', async url => {
      const { registerModelNetwork } = await import('../lib/model-fetch');
      registerModelNetwork();
      const rogue = connection(url);
      state.connect.mock.calls[0]![0](rogue);
      expect(rogue.disconnect).toHaveBeenCalledTimes(1);
    },
  );

  it.each(['http://remote.example/v1', 'file:///tmp/key', 'data:text/plain,token', 'https://user:password@model.example/v1'])(
    'rejects unsafe URLs before creating a document: %s', async url => {
      await expect(modelFetch(url)).rejects.toThrow('HTTPS');
      expect(state.create).not.toHaveBeenCalled();
    },
  );

  it('stops promptly during document initialization without dispatching the cancelled request', async () => {
    state.create.mockImplementation(async () => undefined);
    const controller = new AbortController();
    const pending = modelFetch('https://model.example/one', { signal: controller.signal });
    const rejection = expect(pending).rejects.toMatchObject({ name: 'AbortError' });
    await vi.waitFor(() => expect(state.create).toHaveBeenCalledTimes(1));
    controller.abort();
    await rejection;
    state.connect.mock.calls[0]![0](port);
    port.onMessage.emit({ type: 'ready' });
    await Promise.resolve();
    expect(fetchCommands()).toHaveLength(0);
  });
});
