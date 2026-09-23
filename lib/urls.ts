const RESERVED_GITHUB_ROUTES = new Set([
  'about', 'account', 'apps', 'auth', 'billing', 'blog', 'business', 'codespaces',
  'collections', 'contact', 'copilot', 'customer-stories', 'dashboard', 'discussions',
  'enterprise', 'events', 'explore', 'features', 'home', 'issues', 'join', 'login',
  'logout', 'marketplace', 'new', 'notifications', 'oauth', 'organizations', 'orgs',
  'password_reset', 'pricing', 'projects', 'pulls', 'readme', 'resources', 'search',
  'security', 'sessions', 'settings', 'signup', 'site', 'solutions', 'sponsors',
  'stars', 'team', 'teams', 'topics', 'trending', 'users',
]);

function httpUrl(value: string, base?: URL): URL {
  if (typeof value !== 'string' || !value || /[\u0000-\u0020\u007f]/u.test(value)) {
    throw new Error('URL 必须是有效的 HTTP 或 HTTPS 地址');
  }
  const url = base ? new URL(value, base) : new URL(value);
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) {
    throw new Error('仅支持不含凭证的 HTTP 或 HTTPS 地址');
  }
  return url;
}

function cleanUrl(url: URL): URL {
  // Query encoding and ordering can be part of a resource's identity.
  const parameters = url.search.slice(1).split('&').filter((parameter) => {
    const key = new URLSearchParams(parameter).keys().next().value?.toLowerCase() ?? '';
    return !key.startsWith('utm_') && key !== 'fbclid' && key !== 'gclid';
  });
  url.search = parameters.join('&');
  const hash = url.hash.slice(1);
  if (hash && !/[!/?=&]|%(?:2f|3f|3d|21|26)/iu.test(hash)) url.hash = '';
  return url;
}

export function normalizeUrl(url: string, canonicalUrl?: string): string {
  const original = cleanUrl(httpUrl(url));
  if (canonicalUrl) {
    try {
      const canonical = cleanUrl(httpUrl(canonicalUrl, original));
      // Canonicals cannot erase a version, query, route, or distinct path.
      if (canonical.origin === original.origin && canonical.pathname === original.pathname
        && canonical.search === original.search && canonical.hash === original.hash) {
        return canonical.href;
      }
    } catch {
      // An invalid page-provided canonical does not invalidate the captured URL.
    }
  }
  return original.href;
}

export function parseGithubRepo(url: string): { owner: string; repo: string } | null {
  let parsed: URL;
  try {
    parsed = httpUrl(url);
  } catch {
    return null;
  }
  if (!['github.com', 'www.github.com'].includes(parsed.hostname) || parsed.port) return null;
  const segments = parsed.pathname.replace(/\/$/u, '').slice(1).split('/');
  const [owner, rawRepo, route] = segments;
  if (!owner || !rawRepo || RESERVED_GITHUB_ROUTES.has(owner.toLowerCase())) return null;
  const repo = rawRepo.replace(/\.git$/iu, '');
  if (!/^[a-z\d](?:[a-z\d-]{0,37}[a-z\d])?$/iu.test(owner)
    || !/^[a-z\d_.-]{1,100}$/iu.test(repo) || repo === '.' || repo === '..') return null;
  if (segments.some((segment) => !segment)) return null;
  if (segments.length === 2 || (route === 'tree' && segments.length >= 4)
    || (route === 'blob' && segments.length >= 5 && /^readme\.md$/iu.test(segments.at(-1)!))) {
    return { owner, repo };
  }
  return null;
}
