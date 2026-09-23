import { browser, type Browser } from 'wxt/browser';
import { MODEL_NETWORK_PATH, MODEL_NETWORK_PORT, validateModelNetworkUrl, type ModelNetworkCommand, type ModelNetworkEvent } from './model-network-protocol';

type Port = Browser.runtime.Port;
interface PendingRequest {
  resolve: (response: Response) => void;
  reject: (error: unknown) => void;
  stream?: ReadableStreamDefaultController<Uint8Array>;
  pulled?: () => void;
  cleanup: () => void;
}
const pending = new Map<string, PendingRequest>();
let registered = false;
let networkPort: Port | undefined;
let ready = false;
let creating: Promise<Port> | undefined;
let startup: { resolve: (port: Port) => void; reject: (error: unknown) => void } | undefined;
const disconnectedError = () => new Error('模型网络连接已中断，请重试。');

function failRequest(id: string, error: unknown) {
  const request = pending.get(id);
  if (!request) return;
  pending.delete(id);
  request.cleanup();
  request.pulled?.();
  request.stream?.error(error);
  request.reject(error);
}

function post(command: ModelNetworkCommand) {
  if (!networkPort) throw disconnectedError();
  networkPort.postMessage(command);
}

// Registration is also lazy so every model entry point can use modelFetch directly.
export function registerModelNetwork(): void {
  if (registered) return;
  registered = true;
  browser.runtime.onConnect.addListener(port => {
    if (port.name !== MODEL_NETWORK_PORT) return;
    if (port.sender?.id !== browser.runtime.id || port.sender.url !== browser.runtime.getURL(MODEL_NETWORK_PATH)
      || port.sender.tab || networkPort) { port.disconnect(); return; }
    networkPort = port;
    port.onDisconnect.addListener(() => {
      if (networkPort !== port) return;
      networkPort = undefined;
      ready = false;
      startup?.reject(disconnectedError());
      for (const id of pending.keys()) failRequest(id, disconnectedError());
    });
    port.onMessage.addListener((event: ModelNetworkEvent) => {
      if (event.type === 'ready') { ready = true; startup?.resolve(port); return; }
      if (event.type === 'heartbeat') return;
      const request = pending.get(event.id);
      if (!request) return;
      if (event.type === 'error') {
        failRequest(event.id, event.timeout ? new DOMException('模型请求超时。', 'TimeoutError') : new Error('模型网络请求失败，请检查连接。'));
      } else if (event.type === 'end') {
        pending.delete(event.id);
        request.cleanup();
        request.pulled?.();
        request.stream?.close();
      } else if (event.type === 'chunk') {
        request.stream?.enqueue(Uint8Array.from(event.bytes));
        request.pulled?.();
        request.pulled = undefined;
      } else if (event.type === 'headers') {
        try {
          const body = event.body ? new ReadableStream<Uint8Array>({
            start(controller) { request.stream = controller; },
            pull() {
              return new Promise<void>(resolve => {
                request.pulled = resolve;
                try { post({ type: 'pull', id: event.id }); }
                catch (error) { failRequest(event.id, error); }
              });
            },
            cancel() {
              pending.delete(event.id);
              request.cleanup();
              request.pulled?.();
              try { post({ type: 'abort', id: event.id }); } catch { /* The worker already disconnected. */ }
            },
          }, { highWaterMark: 0 }) : null;
          request.resolve(new Response(body, { status: event.status, statusText: event.statusText, headers: event.headers }));
        } catch (error) {
          try { post({ type: 'abort', id: event.id }); } catch { /* The worker already disconnected. */ }
          failRequest(event.id, error);
        }
      }
    });
  });
}

async function ensureNetwork(): Promise<Port> {
  registerModelNetwork();
  if (networkPort && ready) return networkPort;
  if (creating) return creating;
  creating = (async () => {
    // A surviving document belongs to a terminated background and must lose its old requests.
    const contexts = await browser.runtime.getContexts({ contextTypes: ['OFFSCREEN_DOCUMENT'], documentUrls: [browser.runtime.getURL(MODEL_NETWORK_PATH)] });
    if (networkPort && ready) return networkPort;
    if (contexts.length) await browser.offscreen.closeDocument();
    const connected = new Promise<Port>((resolve, reject) => { startup = { resolve, reject }; });
    const timer = setTimeout(() => startup?.reject(new Error('模型网络初始化超时，请重试。')), 10000);
    try {
      await Promise.all([
        connected,
        browser.offscreen.createDocument({
          url: MODEL_NETWORK_PATH, reasons: [browser.offscreen.Reason.WORKERS],
          justification: 'Run a dedicated worker for user-requested model requests beyond the service worker fetch deadline.',
        }),
      ]);
      return await connected;
    } catch (error) {
      networkPort?.disconnect();
      networkPort = undefined;
      ready = false;
      await browser.offscreen.closeDocument().catch(() => undefined);
      throw error;
    } finally { clearTimeout(timer); startup = undefined; }
  })().finally(() => { creating = undefined; });
  return creating;
}

function withAbort<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  signal.throwIfAborted();
  return new Promise((resolve, reject) => {
    const abort = () => reject(signal.reason);
    signal.addEventListener('abort', abort, { once: true });
    promise.then(resolve, reject).finally(() => signal.removeEventListener('abort', abort));
  });
}

export async function modelFetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  validateModelNetworkUrl(input instanceof Request ? input.url : String(input));
  const request = new Request(input, { ...init, redirect: 'error', credentials: 'omit' });
  request.signal.throwIfAborted();
  const body = request.body ? Array.from(new Uint8Array(await withAbort(request.arrayBuffer(), request.signal))) : undefined;
  const port = await withAbort(ensureNetwork(), request.signal);
  request.signal.throwIfAborted();
  const id = crypto.randomUUID();
  return new Promise<Response>((resolve, reject) => {
    const abort = () => {
      try { port.postMessage({ type: 'abort', id } satisfies ModelNetworkCommand); } catch { /* The worker already disconnected. */ }
      failRequest(id, request.signal.reason);
    };
    pending.set(id, { resolve, reject, cleanup: () => request.signal.removeEventListener('abort', abort) });
    request.signal.addEventListener('abort', abort, { once: true });
    try {
      port.postMessage({ type: 'fetch', id, url: request.url, method: request.method, headers: [...request.headers], body } satisfies ModelNetworkCommand);
    } catch (error) { failRequest(id, error); }
  });
}
