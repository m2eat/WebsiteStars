import { test, expect, chromium } from '@playwright/test';
import { createServer } from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

test('model lists use draft connection, preserve manual choices and timeout settings survive reload', async () => {
  const requests: { url: string; auth: string | undefined; method: string | undefined }[] = [];
  const server = createServer((request, response) => {
    requests.push({ url: request.url ?? '', auth: request.headers.authorization, method: request.method });
    response.setHeader('Access-Control-Allow-Origin', '*'); response.setHeader('Content-Type', 'application/json');
    if (request.url === '/empty/models') { response.end(JSON.stringify({ data: [] })); return; }
    if (request.url === '/denied/models') { response.writeHead(401); response.end(JSON.stringify({ error: 'DO-NOT-RENDER-SECRET' })); return; }
    if (request.url === '/missing/models') { response.writeHead(404); response.end('{}'); return; }
    if (request.url === '/malformed/models') { response.end('<html>invalid</html>'); return; }
    if (request.url === '/v1/models') { response.end(JSON.stringify({ data: [{ id: 'slow-reasoner', name: 'Slow Reasoner' }, { id: 'fast-agent' }, { id: 'fast-agent' }] })); return; }
    response.writeHead(404); response.end('{}');
  });
  await new Promise<void>(ready => server.listen(0, '127.0.0.1', ready));
  const address = server.address(); if (!address || typeof address === 'string') throw new Error('No server');
  const origin = `http://127.0.0.1:${address.port}`;
  const profile = await mkdtemp(join(tmpdir(), 'starts-models-'));
  const extension = resolve('.output/chrome-mv3');
  const context = await chromium.launchPersistentContext(profile, { channel: 'chromium', locale: 'zh-CN', headless: true, reducedMotion: 'reduce', viewport: { width: 1280, height: 900 }, args: ['--no-proxy-server', `--disable-extensions-except=${extension}`, `--load-extension=${extension}`] });
  try {
    const worker = context.serviceWorkers()[0] ?? await context.waitForEvent('serviceworker');
    const page = await context.newPage(); await page.goto(`chrome-extension://${new URL(worker.url()).hostname}/options.html`);
    await expect(page.getByLabel('单次模型请求超时（秒）', { exact: true })).toHaveValue('180');
    await expect(page.getByLabel('整轮查询超时（秒）', { exact: true })).toHaveValue('900');
    expect(requests).toHaveLength(0);
    await page.getByLabel('服务地址', { exact: true }).fill(`${origin}/v1`);
    await page.getByLabel('API Key', { exact: true }).fill('model-fixture-key');
    await page.getByRole('button', { name: '获取模型列表', exact: true }).click();
    await expect(page.getByText('已获取 2 个模型，选择后请保存设置。', { exact: true })).toBeVisible();
    expect(requests).toEqual([{ url: '/v1/models', method: 'GET', auth: 'Bearer model-fixture-key' }]);
    await page.getByLabel('筛选模型', { exact: true }).fill('slow');
    await expect(page.getByLabel('选择已获取的模型').locator('option')).toHaveCount(2);
    await page.getByLabel('选择已获取的模型').selectOption('slow-reasoner');
    await expect(page.getByLabel('模型', { exact: true })).toHaveValue('slow-reasoner');
    await page.getByLabel('单次模型请求超时（秒）', { exact: true }).fill('600');
    await page.getByLabel('整轮查询超时（秒）', { exact: true }).fill('1800');
    await page.getByRole('button', { name: '保存设置', exact: true }).click();
    await expect(page.getByText('设置已保存，AI 已关闭。本地收藏与搜索照常可用。', { exact: true })).toBeVisible();
    await page.reload();
    await expect(page.getByLabel('模型', { exact: true })).toHaveValue('slow-reasoner');
    await expect(page.getByLabel('单次模型请求超时（秒）', { exact: true })).toHaveValue('600');
    await expect(page.getByLabel('整轮查询超时（秒）', { exact: true })).toHaveValue('1800');
    expect(requests).toHaveLength(1);
    await page.getByLabel('整轮查询超时（秒）', { exact: true }).fill('100');
    await page.getByRole('button', { name: '保存设置', exact: true }).click();
    expect(await page.getByLabel('整轮查询超时（秒）', { exact: true }).evaluate(node => (node as HTMLInputElement).validity.valid)).toBe(false);
    await page.getByLabel('整轮查询超时（秒）', { exact: true }).fill('1800');
    for (const [path, message] of [['empty', '空模型列表'], ['denied', '未获授权'], ['missing', '未提供模型列表接口'], ['malformed', '不是有效 JSON']]) {
      await page.getByLabel('服务地址', { exact: true }).fill(`${origin}/${path}`);
      await expect(page.getByLabel('选择已获取的模型')).toHaveCount(0);
      await page.getByRole('button', { name: '获取模型列表', exact: true }).click();
      await expect(page.getByText(new RegExp(message!))).toBeVisible();
      await expect(page.getByLabel('模型', { exact: true })).toHaveValue('slow-reasoner');
      expect(await page.locator('body').innerText()).not.toContain('DO-NOT-RENDER-SECRET');
    }
    await page.getByLabel('模型', { exact: true }).fill('manually-entered');
    await page.getByLabel('服务地址', { exact: true }).fill(`${origin}/v1`);
    await page.getByRole('button', { name: '获取模型列表', exact: true }).click();
    await expect(page.getByText('已获取 2 个模型，选择后请保存设置。', { exact: true })).toBeVisible();
    await expect(page.getByLabel('模型', { exact: true })).toHaveValue('manually-entered');
    await page.setViewportSize({ width: 390, height: 844 }); await page.emulateMedia({ colorScheme: 'dark' });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await page.screenshot({ path: 'test-results/models-timeouts-dark-mobile.png', fullPage: true, animations: 'disabled' });
    await page.getByLabel('选择已获取的模型').selectOption('fast-agent');
    await page.getByRole('button', { name: '保存设置', exact: true }).click();
    await expect(page.getByText('设置已保存，AI 已关闭。本地收藏与搜索照常可用。', { exact: true })).toBeVisible();
    const another = await context.newPage(); await another.goto(page.url());
    await expect(another.getByLabel('模型', { exact: true })).toHaveValue('fast-agent');
    await expect(another.getByLabel('单次模型请求超时（秒）', { exact: true })).toHaveValue('600');
  } finally { await context.close(); server.closeAllConnections(); await new Promise<void>(closed => server.close(() => closed())); await rm(profile, { recursive: true, force: true }); }
});
