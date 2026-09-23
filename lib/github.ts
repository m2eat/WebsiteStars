import { parseGithubRepo } from './urls';
import type { Capture } from './types';

export class PrivateRepositoryError extends Error {
  constructor() { super('该仓库为私有仓库，仅保留本地收藏，不允许 AI 分析。'); }
}

export async function fetchGithub(url: string, token: string, signal?: AbortSignal): Promise<Capture> {
  const repo = parseGithubRepo(url);
  if (!repo) throw new Error('请输入 GitHub 仓库首页地址。');
  const path = `${encodeURIComponent(repo.owner)}/${encodeURIComponent(repo.repo)}`;
  const headers: Record<string, string> = { Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28' };
  if (token) headers.Authorization = `Bearer ${token}`;
  const requestSignal = () => signal ? AbortSignal.any([signal, AbortSignal.timeout(12000)]) : AbortSignal.timeout(12000);
  const response = await fetch(`https://api.github.com/repos/${path}`, { headers, signal: requestSignal(), redirect: 'error' });
  if (!response.ok) throw new Error(`GitHub 元数据暂不可用（HTTP ${response.status}），已保留本地收藏。`);
  const data = await response.json();
  if (data.private === true) throw new PrivateRepositoryError();
  if (data.private !== false) throw new Error('无法确认仓库是否公开，请稍后重试。');
  let snapshot: Pick<Capture, 'content' | 'excerpt' | 'truncated'> = {};
  try {
    const readme = await fetch(`https://api.github.com/repos/${path}/readme`, { headers, signal: requestSignal(), redirect: 'error' });
    if (readme.ok) {
      const file = await readme.json();
      if (file.encoding === 'base64' && typeof file.content === 'string') {
        const bytes = Uint8Array.from(atob(file.content.replace(/\s/g, '')), c => c.charCodeAt(0));
        const text = new TextDecoder().decode(bytes);
        snapshot = { content: text.slice(0, 100000), truncated: text.length > 100000, excerpt: text.slice(0, 1200) };
      }
    }
  } catch { /* Failed reads leave the previous snapshot untouched. */ }
  signal?.throwIfAborted();
  return {
    url, source: 'github', description: String(data.description ?? '').slice(0, 10000), ...snapshot,
    tags: (data.topics ?? []).slice(0, 30), keywords: [data.language, ...(data.topics ?? [])].filter(Boolean),
    github: { repoId: data.id, ...repo, language: data.language ?? '', license: data.license?.spdx_id ?? '', stars: data.stargazers_count ?? 0, topics: (data.topics ?? []).slice(0, 30), fetchedAt: new Date().toISOString() },
  };
}
