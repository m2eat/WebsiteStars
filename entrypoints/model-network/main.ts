import { browser } from 'wxt/browser';
import ModelNetworkWorker from './network-worker?worker';
import { MODEL_NETWORK_PORT, type ModelNetworkCommand, type ModelNetworkEvent } from '../../lib/model-network-protocol';

const port = browser.runtime.connect({ name: MODEL_NETWORK_PORT });
const worker = new ModelNetworkWorker();
const active = new Set<string>();
let heartbeat: ReturnType<typeof setInterval> | undefined;

function syncHeartbeat() {
  if (active.size && !heartbeat) heartbeat = setInterval(() => {
    port.postMessage({ type: 'heartbeat' } satisfies ModelNetworkEvent);
  }, 20000);
  if (!active.size && heartbeat) { clearInterval(heartbeat); heartbeat = undefined; }
}

port.onMessage.addListener((command: ModelNetworkCommand) => {
  if (command.type === 'fetch') active.add(command.id);
  if (command.type === 'abort') active.delete(command.id);
  syncHeartbeat();
  worker.postMessage(command);
});
worker.onmessage = (message: MessageEvent<ModelNetworkEvent>) => {
  if (message.data.type === 'end' || message.data.type === 'error') active.delete(message.data.id);
  syncHeartbeat();
  port.postMessage(message.data);
};
worker.onerror = () => {
  for (const id of active) port.postMessage({ type: 'error', id, timeout: false } satisfies ModelNetworkEvent);
  active.clear();
  syncHeartbeat();
  worker.terminate();
  port.disconnect();
};
port.onDisconnect.addListener(() => {
  active.clear();
  syncHeartbeat();
  worker.terminate();
});
