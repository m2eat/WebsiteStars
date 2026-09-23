import type { Settings } from './types';

export const modelTimeoutMs = (settings: Pick<Settings, 'modelTimeoutSeconds'>) => settings.modelTimeoutSeconds * 1000;
export const queryTimeoutMs = (settings: Pick<Settings, 'queryTimeoutSeconds'>) => settings.queryTimeoutSeconds * 1000;

export function agentTimeout(settings: Settings, probe = false) {
  const stepMs = modelTimeoutMs(settings);
  return { totalMs: probe ? stepMs : queryTimeoutMs(settings), stepMs, firstChunkMs: stepMs };
}
