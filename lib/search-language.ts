const words = new Intl.Segmenter('zh', { granularity: 'word' });
const technicalWords = /(?:[a-z][a-z\d]*(?:\+\+|#)|[a-z\d]+(?:[._-][a-z\d]+)+)/giu;
const exactTechnical = /(?:\+\+|#)$/u;
const folded = (text: string) => text.normalize('NFKC').toLowerCase().trim();
const aliases: Record<string, string> = {
  ts: 'typescript', typescript: 'typescript', js: 'javascript', javascript: 'javascript',
  py: 'python', python: 'python', golang: 'go', go: 'go',
  'c#': 'c#', csharp: 'c#', 'c++': 'c++', cpp: 'c++',
};
export const languageName = (language: string) => aliases[folded(language)] ?? folded(language);
export const unknownLanguage = (language: string) => ['', 'unknown', '未知', 'all', 'any', 'unspecified', 'n/a', '不限'].includes(folded(language));

export function tokenize(text: string): string[] {
  const input = folded(text);
  const tokens: string[] = [];
  const add = (part: string) => {
    for (const word of words.segment(part)) if (word.isWordLike) tokens.push(word.segment);
  };
  let offset = 0;
  for (const match of input.matchAll(technicalWords)) {
    add(input.slice(offset, match.index));
    tokens.push(match[0]);
    if (!exactTechnical.test(match[0])) tokens.push(...match[0].split(/[._-]/u));
    offset = match.index! + match[0].length;
  }
  add(input.slice(offset));
  return [...new Set(tokens.map(token => aliases[token] ?? token))];
}
