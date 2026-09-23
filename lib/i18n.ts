import ui from './locales/en-ui';
import settings from './locales/en-settings';
import extension from './locales/en-extension';
import runtime from './locales/en-runtime';

export type Locale = 'en' | 'zh-CN';
type Values = Record<string, string | number>;

export const englishMessages: Record<string, string> = {
  ...runtime, ...extension, ...settings, ...ui,
  '我的资料库': 'My library',
  '资料库侧栏': 'Library sidebar',
  '设置与数据': 'Settings & data',
  '操作未完成，请重试。': 'The operation could not be completed. Please try again.',
};

export function resolveLocale(language: string): Locale {
  return /^zh(?:[-_]|$)/i.test(language) ? 'zh-CN' : 'en';
}

export function getLocale(): Locale {
  if (typeof navigator !== 'undefined') {
    const language = navigator.languages?.[0] || navigator.language;
    if (language) return resolveLocale(language);
  }
  try {
    const language = (globalThis as typeof globalThis & {
      chrome?: { i18n?: { getUILanguage?: () => string } };
    }).chrome?.i18n?.getUILanguage?.();
    if (language) return resolveLocale(language);
  } catch { /* The extension context may have been invalidated. */ }
  return 'en';
}

const interpolate = (message: string, values: Values) => message.replace(/\{(\w+)\}/g,
  (match, name: string) => Object.hasOwn(values, name) ? String(values[name]) : match);
const escapeRegex = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const templates = Object.entries(englishMessages).flatMap(([source, translated]) => {
  const names: string[] = [];
  let cursor = 0;
  let pattern = '^';
  for (const match of source.matchAll(/\{(\w+)\}/g)) {
    pattern += escapeRegex(source.slice(cursor, match.index)) + '([\\s\\S]*?)';
    names.push(match[1]!);
    cursor = match.index! + match[0].length;
  }
  if (!names.length) return [];
  pattern += escapeRegex(source.slice(cursor)) + '$';
  return [{ expression: new RegExp(pattern), names, translated }];
});

// Runtime errors and persisted progress messages may already contain their values.
function translateRuntime(source: string): string {
  if (Object.hasOwn(englishMessages, source)) return englishMessages[source]!;
  for (const { expression, names, translated } of templates) {
    const match = source.match(expression);
    if (match) return interpolate(translated, Object.fromEntries(names.map((name, index) => [name, match[index + 1]!])));
  }
  return source;
}

export function t(source: string, values: Values = {}): string {
  return interpolate(getLocale() === 'en' ? translateRuntime(source) : source, values);
}

export function translateError(error: unknown): string {
  const source = error instanceof Error ? error.message : typeof error === 'string' ? error : '操作未完成，请重试。';
  const translated = t(source);
  if (getLocale() === 'en' && translated === source && /[\u3400-\u9fff]/u.test(source)) {
    return englishMessages['操作未完成，请重试。']!;
  }
  return translated;
}

export function initializePage(title: string): void {
  document.documentElement.lang = getLocale();
  document.documentElement.dir = 'ltr';
  document.title = `${t(title)} · WebsiteStars`;
}
