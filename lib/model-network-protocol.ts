export const MODEL_NETWORK_PORT = 'starts-model-network';
export const MODEL_NETWORK_PATH = '/model-network.html';
// Bounds orphaned requests to the largest supported model timeout.
export const MAX_MODEL_NETWORK_MS = 1800_000;

export type ModelNetworkCommand =
  | { type: 'fetch'; id: string; url: string; method: string; headers: [string, string][]; body?: number[] }
  | { type: 'pull' | 'abort'; id: string };
export type ModelNetworkEvent =
  | { type: 'ready' }
  | { type: 'heartbeat' }
  | { type: 'headers'; id: string; status: number; statusText: string; headers: [string, string][]; body: boolean }
  | { type: 'chunk'; id: string; bytes: number[] }
  | { type: 'end'; id: string }
  | { type: 'error'; id: string; timeout: boolean };

export function validateModelNetworkUrl(value: string): void {
  const url = new URL(value);
  if (url.username || url.password || (url.protocol !== 'https:'
    && !(url.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)))) {
    throw new Error('模型端点无效，请使用 HTTPS 或本机 HTTP 地址。');
  }
}
