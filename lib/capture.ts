import { browser } from 'wxt/browser';
import { db, enrichItem, saveCapture } from './library';
import { assertAllowed, getSettings } from './settings';
import { normalizeUrl, parseGithubRepo } from './urls';
import { drainQueue, persistCaptureJob, queueGithubRefresh } from './analysis';
import type { Capture, Settings } from './types';

function retention(capture: Capture, settings: Settings): Capture {
  return settings.retainContent ? capture : { ...capture, content: '', truncated: false };
}

export async function savePage(capture: Capture) {
  const settings = await getSettings();
  assertAllowed(capture.url, settings, false);
  const repo = parseGithubRepo(capture.url);
  const value = retention({ ...capture, ...(repo ? { url: `https://github.com/${repo.owner.toLowerCase()}/${repo.repo.toLowerCase()}`, canonicalUrl: undefined, source: 'github' as const } : {}) }, settings);
  const result = await db.transaction('rw', db.items, db.jobs, async () => {
    const saved = await saveCapture(value);
    let upgraded = false;
    if (!saved.created && !saved.item.content && value.content) {
      const updated = await enrichItem(saved.item.id, value, saved.item.contentVersion);
      if (updated) { saved.item = updated; upgraded = true; }
    }
    if (saved.created || upgraded) {
      await persistCaptureJob(saved.item, settings);
      saved.item = await db.items.get(saved.item.id) ?? saved.item;
    }
    return saved;
  });
  void drainQueue().catch(() => undefined);
  return result;
}

export async function saveUrl(input: string, title?: string) {
  const value = input.trim();
  const url = /^[\w.-]+\/[\w.-]+$/.test(value) ? `https://github.com/${value}` : value;
  normalizeUrl(url);
  const repo = parseGithubRepo(url);
  return savePage({ url, title: title?.trim() || (repo ? `${repo.owner}/${repo.repo}` : new URL(url).hostname), source: repo ? 'github' : 'article' });
}

export async function captureTab(tabId?: number, selection?: string) {
  let tab;
  if (tabId !== undefined) tab = await browser.tabs.get(tabId);
  else {
    const tabs = await browser.tabs.query({ active: true, lastFocusedWindow: true });
    tab = tabs[0];
    if (tab?.url?.startsWith(browser.runtime.getURL('/'))) {
      tab = (await browser.tabs.query({ lastFocusedWindow: true })).filter(candidate => /^https?:/.test(candidate.url ?? '')).sort((a, b) => (b.lastAccessed ?? 0) - (a.lastAccessed ?? 0))[0];
    }
  }
  if (!tab?.id || !tab.url || !/^https?:/.test(tab.url)) throw new Error('请在普通网页使用悬浮收藏或侧栏的“保存当前页”；浏览器内部页面无法采集。');
  const settings = await getSettings();
  assertAllowed(tab.url, settings, false);
  let capture: Capture = { url: tab.url, title: tab.title || tab.url };
  try {
    await browser.scripting.executeScript({ target: { tabId: tab.id }, files: ['/content-scripts/extract.js'] });
    const extracted = await browser.tabs.sendMessage(tab.id, { type: 'extractPage' }) as Capture;
    if (extracted && new URL(extracted.url).origin === new URL(tab.url).origin) capture = extracted;
  } catch {
    // Restricted documents still support a link-only save when the tab URL is visible.
  }
  if (selection) capture.selection = selection.slice(0, 20000);
  return savePage(capture);
}

export async function refreshGithub(id: string) {
  await queueGithubRefresh(id);
  await drainQueue();
  const item = await db.items.get(id);
  if (!item) throw new Error('该收藏已删除。');
  if (item.githubVisibility === 'private') throw new Error('该仓库为私有仓库，不允许 AI 分析。');
  if ((await db.jobs.get(id))?.kind === 'github') throw new Error(item.analysisError || '仓库刷新已排队，请稍后查看。');
  if (item.analysisStatus === 'failed' && !item.github) throw new Error(item.analysisError || '仓库刷新失败，请重试。');
}
