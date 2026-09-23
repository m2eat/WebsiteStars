import { test, expect, chromium, type Page } from '@playwright/test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import type { Item } from '../../lib/types';

const longTitle = 'GitHub - Tencent/WeKnora: Open-source LLM-powered knowledge platform: turn raw documents into a queryable RAG and autonomous reasoning agent, with a self-maintaining Wiki. 技术资料与知识管理';
function fixtures(): Item[] {
  const date = '2026-09-22T12:00:00.000Z';
  return Array.from({ length: 14 }, (_, index) => {
    const url = index === 0 ? 'https://github.com/tencent/weknora' : `https://example.com/${index}`;
    return {
      id: `theme-fixture-${index}`, url, normalizedUrl: url,
      title: index === 0 ? longTitle : `开发文档 ${index} — TypeScript、Workers 与浏览器存储`,
      description: '保存技术文章与开源项目，使用关键词、标签和私人笔记进行本地检索。',
      excerpt: '离线资料库与中文检索', content: '这是保存的正文，不应在切换主题或调整侧栏时改变。', truncated: false,
      source: index === 0 ? 'github' : index % 2 ? 'article' : 'docs', domain: new URL(url).hostname,
      author: '', publishedAt: '', tags: index === 0 ? ['知识管理', 'TypeScript', '超长标签用于验证侧栏边界' + 'long'.repeat(12)] : ['开发文档'],
      keywords: [], category: '开发工具', notes: '原有私人笔记', selections: [], analysisStatus: 'disabled',
      createdAt: date, updatedAt: date, contentVersion: 1,
      ...(index === 0 ? { github: { owner: 'tencent', repo: 'weknora', language: 'TypeScript', license: 'MIT', topics: ['知识管理'], stars: 29000, fetchedAt: date } } : {}),
    };
  });
}

async function assertTheme(page: Page, theme: 'light' | 'dark') {
  await expect(page.locator('html')).toHaveAttribute('data-theme', theme);
  await expect(page.locator('html')).toHaveClass(theme);
  const colors = await page.evaluate(() => {
    const canvas = document.createElement('canvas'); canvas.width = canvas.height = 1;
    const context = canvas.getContext('2d')!;
    const brightness = (color: string) => {
      context.clearRect(0, 0, 1, 1); context.fillStyle = color; context.fillRect(0, 0, 1, 1);
      const values = context.getImageData(0, 0, 1, 1).data;
      return (values[0]! + values[1]! + values[2]!) / 3;
    };
    const style = getComputedStyle(document.body);
    return { background: brightness(style.backgroundColor), foreground: brightness(style.color), scheme: getComputedStyle(document.documentElement).colorScheme };
  });
  expect(colors.scheme).toBe(theme);
  if (theme === 'dark') { expect(colors.background).toBeLessThan(60); expect(colors.foreground).toBeGreaterThan(180); }
  else { expect(colors.background).toBeGreaterThan(220); expect(colors.foreground).toBeLessThan(80); }
}

async function assertWithinViewport(page: Page, selector: string) {
  const box = (await page.locator(selector).boundingBox())!;
  const viewport = page.viewportSize()!;
  expect(box.x).toBeGreaterThanOrEqual(0);
  expect(box.x + box.width).toBeLessThanOrEqual(viewport.width + 1);
  expect(box.y).toBeGreaterThanOrEqual(0);
  expect(box.y + box.height).toBeLessThanOrEqual(viewport.height + 1);
}

test('system themes update every page and dialogs; sidepanel adapts without losing state', async () => {
  test.setTimeout(120000);
  const profile = await mkdtemp(join(tmpdir(), 'starts-theme-'));
  const extension = resolve('.output/chrome-mv3');
  const context = await chromium.launchPersistentContext(profile, {
    channel: 'chromium', locale: 'zh-CN', headless: true, colorScheme: 'dark', reducedMotion: 'reduce', viewport: { width: 1440, height: 1000 },
    args: [`--disable-extensions-except=${extension}`, `--load-extension=${extension}`],
  });
  const errors: string[] = [];
  context.on('page', page => page.on('pageerror', error => errors.push(error.message)));
  try {
    const worker = context.serviceWorkers()[0] ?? await context.waitForEvent('serviceworker');
    const base = `chrome-extension://${new URL(worker.url()).hostname}`;
    const library = await context.newPage(); await library.goto(`${base}/library.html`);
    const sidebar = await context.newPage(); await sidebar.goto(`${base}/sidepanel.html`);
    await sidebar.setViewportSize({ width: 320, height: 600 });
    const options = await context.newPage(); await options.goto(`${base}/options.html`);
    for (const page of [library, sidebar, options]) await assertTheme(page, 'dark');
    await expect(sidebar.getByText('还没有收藏', { exact: true })).toBeVisible();
    await sidebar.getByRole('button', { name: '刷新资料库' }).click();
    await expect(sidebar.locator('.item-list > li')).toHaveCount(0);
    await sidebar.screenshot({ path: 'test-results/sidepanel-empty-dark.png', animations: 'disabled' });
    await options.getByLabel('选择 JSON 备份文件').setInputFiles({
      name: 'layout.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify({ schemaVersion: 1, exportedAt: '2026-09-22T12:00:00.000Z', items: fixtures() })),
    });
    await options.getByRole('button', { name: '确认导入 14 条', exact: true }).click();
    await expect(library.locator('.item-list > li')).toHaveCount(14);
    await expect(sidebar.locator('.item-list > li')).toHaveCount(14);
    for (const theme of ['dark', 'light'] as const) {
      await Promise.all([library, sidebar, options].map(page => page.emulateMedia({ colorScheme: theme })));
      for (const page of [library, sidebar, options]) await assertTheme(page, theme);
      for (const [width, height] of [[280, 480], [320, 360], [320, 480], [390, 844], [540, 600], [760, 500]]) {
        await sidebar.setViewportSize({ width: width!, height: height! });
        expect(await sidebar.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
        expect(await sidebar.evaluate(() => document.documentElement.scrollHeight <= innerHeight + 1)).toBe(true);
        await assertWithinViewport(sidebar, '.results-content');
        await assertWithinViewport(sidebar, '.results-actions');
        await assertWithinViewport(sidebar, '.heading-actions');
        const title = sidebar.locator('.item-title', { hasText: longTitle });
        expect(await title.evaluate(node => node.getBoundingClientRect().height <= parseFloat(getComputedStyle(node).lineHeight) * 2 + 1)).toBe(true);
        await expect(title).toHaveAttribute('title', longTitle);
        expect(await sidebar.locator('.item-tags [data-slot="chip"]').first().evaluate(node => node.getBoundingClientRect().height)).toBeLessThanOrEqual(24);
        await sidebar.getByRole('button', { name: '展开筛选条件' }).click();
        await assertWithinViewport(sidebar, '.filter-controls');
        await sidebar.getByLabel('按标签筛选').selectOption('开发文档');
        await expect(sidebar.locator('.item-list > li')).toHaveCount(13);
        await sidebar.getByRole('button', { name: '清除筛选', exact: true }).click();
        await sidebar.getByRole('button', { name: '展开筛选条件' }).click();
        await sidebar.locator('.results-content').evaluate(node => { node.scrollTop = 0; });
        if (width === 390 || width === 320) await sidebar.screenshot({ path: `test-results/sidepanel-${theme}-${width}.png`, animations: 'disabled' });
      }
      await library.screenshot({ path: `test-results/library-${theme}.png`, fullPage: true, animations: 'disabled' });
      await options.setViewportSize({ width: 390, height: 844 });
      expect(await options.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
      await options.screenshot({ path: `test-results/options-${theme}-390.png`, fullPage: true, animations: 'disabled' });
    }
    await sidebar.setViewportSize({ width: 390, height: 600 });
    const searchBefore = (await sidebar.getByRole('searchbox', { name: '搜索收藏' }).boundingBox())!;
    await sidebar.locator('.results-content').hover(); await sidebar.mouse.wheel(0, 1000);
    await expect.poll(() => sidebar.locator('.results-content').evaluate(node => node.scrollTop)).toBeGreaterThan(0);
    expect((await sidebar.getByRole('searchbox', { name: '搜索收藏' }).boundingBox())!.y).toBe(searchBefore.y);
    await sidebar.getByRole('searchbox', { name: '搜索收藏' }).fill('WeKnora');
    await sidebar.getByRole('tab', { name: /GitHub/ }).click();
    await sidebar.getByLabel('排序方式').selectOption('stars');
    await sidebar.emulateMedia({ colorScheme: 'dark' }); await assertTheme(sidebar, 'dark');
    await expect(sidebar.getByRole('searchbox', { name: '搜索收藏' })).toHaveValue('WeKnora');
    await expect(sidebar.getByLabel('排序方式')).toHaveValue('stars');
    await sidebar.getByRole('button', { name: '刷新资料库' }).click();
    await expect(sidebar.locator('.item-list > li')).toHaveCount(1);
    await sidebar.getByRole('button', { name: `查看详情：${longTitle}` }).click();
    await expect(sidebar.getByRole('heading', { name: longTitle, exact: true })).toBeVisible();
    const darkDialog = await sidebar.getByRole('dialog').evaluate(node => getComputedStyle(node).backgroundColor);
    await sidebar.getByRole('button', { name: '编辑', exact: true }).click();
    await sidebar.getByLabel('私人笔记', { exact: true }).fill('主题切换时保留未保存的编辑');
    await sidebar.emulateMedia({ colorScheme: 'light' }); await assertTheme(sidebar, 'light');
    await expect(sidebar.getByLabel('私人笔记', { exact: true })).toHaveValue('主题切换时保留未保存的编辑');
    expect(await sidebar.getByRole('dialog').evaluate(node => getComputedStyle(node).backgroundColor)).not.toBe(darkDialog);
    await sidebar.emulateMedia({ colorScheme: 'dark' }); await sidebar.setViewportSize({ width: 320, height: 480 });
    await sidebar.getByRole('button', { name: '保存修改', exact: true }).click();
    await sidebar.getByRole('tab', { name: '笔记与划词', exact: true }).click();
    await expect(sidebar.getByText('主题切换时保留未保存的编辑', { exact: true })).toBeVisible();
    await sidebar.screenshot({ path: 'test-results/detail-dark-320.png', animations: 'disabled' });
    await sidebar.getByRole('button', { name: '删除收藏', exact: true }).click();
    await expect(sidebar.getByRole('dialog', { name: '删除这条收藏？' })).toBeVisible();
    await sidebar.getByRole('button', { name: '保留收藏', exact: true }).click();
    await sidebar.getByRole('button', { name: '关闭弹窗' }).last().click();
    await sidebar.getByRole('searchbox', { name: '搜索收藏' }).fill('不存在的词');
    await expect(sidebar.getByText('暂时没有找到', { exact: true })).toBeVisible();
    await sidebar.getByRole('button', { name: '清除搜索与筛选' }).click();
    await expect(sidebar.locator('.item-list > li')).toHaveCount(14);
    await options.emulateMedia({ colorScheme: 'dark' });
    await options.getByLabel('GitHub Token（可选）', { exact: true }).fill('test-unsaved-theme');
    await options.emulateMedia({ colorScheme: 'light' });
    await expect(options.getByLabel('GitHub Token（可选）', { exact: true })).toHaveValue('test-unsaved-theme');
    await options.getByLabel('GitHub Token（可选）', { exact: true }).fill('');
    await sidebar.reload(); await assertTheme(sidebar, 'dark');
    await expect(sidebar.locator('.item-list > li')).toHaveCount(14);
    expect(errors).toEqual([]);
  } finally { await context.close(); await rm(profile, { recursive: true, force: true }); }
});
