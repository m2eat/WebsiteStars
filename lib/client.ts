import { browser } from 'wxt/browser';
import type { Command, Reply } from './types';

export async function request<T>(command: Command): Promise<T> {
  const reply = await browser.runtime.sendMessage(command) as Reply<T> | undefined;
  if (!reply) throw new Error('扩展后台暂时不可用，请重新打开页面。');
  if (!reply.ok) throw new Error(reply.error);
  return reply.data;
}
export async function openLibrary() {
  await browser.tabs.create({ url: browser.runtime.getURL('/library.html') });
}
export async function openOptions() {
  await browser.runtime.openOptionsPage();
}
