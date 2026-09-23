import { MAX_MODEL_NETWORK_MS, validateModelNetworkUrl, type ModelNetworkCommand, type ModelNetworkEvent } from '../../lib/model-network-protocol';

interface NetworkRequest {
  controller: AbortController;
  reader?: ReadableStreamDefaultReader<Uint8Array>;
  timer: ReturnType<typeof setTimeout>;
  reading: boolean;
}
const requests = new Map<string, NetworkRequest>();
const send = (event: ModelNetworkEvent) => self.postMessage(event);

function release(id: string) {
  const request = requests.get(id);
  if (!request) return;
  requests.delete(id);
  clearTimeout(request.timer);
  request.controller.abort();
  void request.reader?.cancel().catch(() => undefined);
}

async function start(command: Extract<ModelNetworkCommand, { type: 'fetch' }>) {
  if (requests.has(command.id)) return;
  const controller = new AbortController();
  const request: NetworkRequest = {
    controller, reading: false,
    timer: setTimeout(() => {
      release(command.id);
      send({ type: 'error', id: command.id, timeout: true });
    }, MAX_MODEL_NETWORK_MS),
  };
  requests.set(command.id, request);
  try {
    validateModelNetworkUrl(command.url);
    const response = await fetch(command.url, {
      method: command.method, headers: command.headers,
      body: command.body ? Uint8Array.from(command.body) : undefined,
      signal: controller.signal, redirect: 'error', credentials: 'omit',
    });
    if (!requests.has(command.id)) { await response.body?.cancel(); return; }
    request.reader = response.body?.getReader();
    send({ type: 'headers', id: command.id, status: response.status, statusText: response.statusText, headers: [...response.headers], body: !!request.reader });
    if (!request.reader) { release(command.id); send({ type: 'end', id: command.id }); }
  } catch {
    if (!requests.has(command.id)) return;
    release(command.id);
    send({ type: 'error', id: command.id, timeout: false });
  }
}

async function pull(id: string) {
  const request = requests.get(id);
  if (!request?.reader || request.reading) return;
  request.reading = true;
  try {
    const { value, done } = await request.reader.read();
    if (!requests.has(id)) return;
    if (done) { release(id); send({ type: 'end', id }); }
    else send({ type: 'chunk', id, bytes: Array.from(value) });
  } catch {
    if (!requests.has(id)) return;
    release(id);
    send({ type: 'error', id, timeout: false });
  } finally { request.reading = false; }
}

self.onmessage = (message: MessageEvent<ModelNetworkCommand>) => {
  const command = message.data;
  if (command.type === 'fetch') void start(command);
  else if (command.type === 'pull') void pull(command.id);
  else if (command.type === 'abort') release(command.id);
};
send({ type: 'ready' });
