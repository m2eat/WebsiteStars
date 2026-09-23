import { beforeEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_SETTINGS, type Settings } from '../lib/types';
const state = vi.hoisted(() => ({ settings: {} as Settings }));
vi.mock('wxt/browser', () => ({ browser: {
  storage: { local: {
    get: vi.fn(async () => ({ settings: structuredClone(state.settings) })),
    set: vi.fn(async ({ settings }: { settings: Settings }) => { state.settings = structuredClone(settings); }),
  } },
  permissions: { contains: vi.fn(async () => true) },
} }));
import { assertAllowed, getSettings, saveSettings } from '../lib/settings';

beforeEach(() => { state.settings = { ...DEFAULT_SETTINGS }; });

describe('settings privacy boundaries', () => {
  it('adds generous configurable timeout defaults without losing old credentials', async () => {
    const legacy = { ...DEFAULT_SETTINGS, apiKey: 'keep-secret', revision: 5 } as Partial<Settings>;
    delete legacy.modelTimeoutSeconds; delete legacy.queryTimeoutSeconds;
    state.settings = legacy as Settings;
    expect(await getSettings()).toMatchObject({ apiKey: 'keep-secret', revision: 5, modelTimeoutSeconds: 180, queryTimeoutSeconds: 900 });
    await saveSettings({ ...await getSettings(), modelTimeoutSeconds: 600, queryTimeoutSeconds: 1800 });
    expect(await getSettings()).toMatchObject({ modelTimeoutSeconds: 600, queryTimeoutSeconds: 1800 });
  });
  it.each([
    { modelTimeoutSeconds: 0 }, { modelTimeoutSeconds: 1801 }, { modelTimeoutSeconds: 30.5 },
    { queryTimeoutSeconds: 59 }, { queryTimeoutSeconds: 3601 },
    { modelTimeoutSeconds: 1000, queryTimeoutSeconds: 900 },
  ])('rejects invalid timeout limits %j', async patch => {
    await expect(saveSettings({ ...DEFAULT_SETTINGS, ...patch })).rejects.toThrow();
    expect((await getSettings()).revision).toBe(0);
  });
  it('keeps conversational querying opt-in and independent of capture analysis', async () => {
    const legacy = { ...DEFAULT_SETTINGS, apiKey: 'existing-key', revision: 2 } as Partial<Settings>;
    delete legacy.queryEnabled;
    state.settings = legacy as Settings;
    expect(await getSettings()).toMatchObject({ queryEnabled: false, aiEnabled: false, apiKey: 'existing-key', revision: 2 });
    await saveSettings({ ...await getSettings(), queryEnabled: true });
    expect(await getSettings()).toMatchObject({ queryEnabled: true, aiEnabled: false });
  });
  it('adds the floating-button preference without resetting existing settings', async () => {
    const legacy = { ...DEFAULT_SETTINGS, apiKey: 'existing-key', revision: 7 } as Partial<Settings>;
    delete legacy.floatingEnabled;
    state.settings = legacy as Settings;
    expect(await getSettings()).toMatchObject({ floatingEnabled: true, apiKey: 'existing-key', revision: 7 });
    await saveSettings({ ...await getSettings(), floatingEnabled: false });
    expect(await getSettings()).toMatchObject({ floatingEnabled: false, apiKey: 'existing-key', revision: 8 });
  });
  it('normalizes DNS root dots on both hostnames and blocked domain rules', async () => {
    const settings = await saveSettings({ ...DEFAULT_SETTINGS, blockedDomains: ['PRIVATE.Example.COM.'] });
    expect(settings.blockedDomains).toEqual(['private.example.com']);
    for (const url of ['https://private.example.com/a', 'https://private.example.com./a', 'https://sub.private.example.com./a']) {
      expect(() => assertAllowed(url, settings)).toThrow('禁止');
      expect(() => assertAllowed(url, settings, false)).not.toThrow();
    }
    expect(() => assertAllowed('https://notprivate.example.com/a', settings)).not.toThrow();
    expect(() => assertAllowed('https://private.example.com.evil.test/a', settings)).not.toThrow();
    expect(() => assertAllowed('https://private.example.com/a', { ...settings, blockedDomains: ['PRIVATE.EXAMPLE.COM.'] })).toThrow('禁止');
  });

  it('rejects stale settings instead of restoring removed credentials and AI consent', async () => {
    state.settings = { ...DEFAULT_SETTINGS, aiEnabled: true, apiKey: 'old-key', githubToken: 'old-token' };
    const stale = await getSettings();
    const fresh = await saveSettings({ ...stale, aiEnabled: false, apiKey: '', githubToken: '', blockedDomains: ['private.example.com'] });
    await expect(saveSettings({ ...stale, retainContent: false })).rejects.toThrow('重新加载');
    expect(await getSettings()).toEqual(fresh);
    expect(await getSettings()).toMatchObject({ aiEnabled: false, apiKey: '', githubToken: '', blockedDomains: ['private.example.com'] });
  });

  it('serializes concurrent writes and remains usable after a revision conflict', async () => {
    const original = await getSettings();
    const results = await Promise.allSettled([
      saveSettings({ ...original, blockedDomains: ['one.example'] }),
      saveSettings({ ...original, blockedDomains: ['two.example'] }),
    ]);
    expect(results.filter(result => result.status === 'fulfilled')).toHaveLength(1);
    expect(results.filter(result => result.status === 'rejected')).toHaveLength(1);
    expect((await getSettings()).revision).toBe(1);
    const updated = await saveSettings({ ...await getSettings(), retainContent: false });
    expect(updated.revision).toBe(2);
    expect(updated.retainContent).toBe(false);
  });
});
