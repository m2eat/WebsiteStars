import type { AgentHistoryTurn } from './chat-types';

export interface QueryContext {
  intent: 'find' | 'list' | 'compare'; language?: string; source?: 'github' | 'article' | 'docs';
  retrievalQuestion: string; excludeIds: string[]; compareIds: string[]; previousCandidateIds: string[];
}
const languages: [RegExp, string][] = [
  [/\b(?:typescript|ts)\b/i, 'TypeScript'], [/\b(?:javascript|js)\b/i, 'JavaScript'],
  [/\b(?:python|py)\b/i, 'Python'], [/\b(?:golang|go)\b/i, 'Go'],
  [/\brust\b/i, 'Rust'], [/c\+\+/i, 'C++'], [/c#/i, 'C#'], [/\bjava\b/i, 'Java'],
];

export function buildQueryContext(question: string, history: AgentHistoryTurn[]): QueryContext {
  const result: QueryContext = { intent: 'find', retrievalQuestion: question, excludeIds: [], compareIds: [], previousCandidateIds: [] };
  const turns = [...history.slice(-6).map(turn => ({ question: turn.question, ids: turn.itemIds })), { question, ids: [] }];
  let previous: string[] = [];
  let topic = '';
  for (const [index, turn] of turns.entries()) {
    const text = turn.question;
    if (/重新找|换个话题|new topic|start over/i.test(text)) { result.language = undefined; result.source = undefined; result.excludeIds = []; previous = []; topic = ''; }
    const followUp = /^(?:只看|只要|仅限|限定|必须|不限|不限制|不要|排除|除去|还有|换一个|换一批|找另一个|再找|这两个|这些|它|比较这|对比这|only\b|exclude\b|not the\b|any language|compare (?:these|those))/i.test(text.trim());
    topic = followUp && topic ? `${topic.slice(0, 1200)}\n补充条件：${text.slice(0, 800)}` : text;
    if (/不限语言|不限制语言|any language|all languages/i.test(text)) result.language = undefined;
    else if (/只看|只要|仅限|限定|必须|only|written in/i.test(text)) {
      const match = languages.find(([pattern]) => pattern.test(text));
      if (match) result.language = match[1];
    }
    if (/不限来源|所有来源|any source/i.test(text)) result.source = undefined;
    else if (/只看|只要|仅限|限定|only/i.test(text)) {
      if (/github|仓库|项目/i.test(text)) result.source = 'github';
      else if (/文章|article/i.test(text)) result.source = 'article';
      else if (/文档|documentation|docs/i.test(text)) result.source = 'docs';
    }
    if (/不要|排除|除去|exclude|not the/i.test(text)) {
      if (/第[一1]个|第[一1]条|the first/i.test(text) && previous[0]) result.excludeIds.push(previous[0]);
      else if (/第[二2]个|第[二2]条|the second/i.test(text) && previous[1]) result.excludeIds.push(previous[1]);
      else if (/刚才|这些|之前|previous|those/i.test(text)) result.excludeIds.push(...previous);
    }
    if (index === turns.length - 1) {
      result.retrievalQuestion = topic.slice(0, 2000);
      result.previousCandidateIds = previous;
      result.intent = /比较|对比|区别|compare|difference/i.test(text) ? 'compare' : /全部|所有|列出|有哪些|list all/i.test(text) ? 'list' : 'find';
      if (result.intent === 'compare') result.compareIds = previous.filter(id => id && !result.excludeIds.includes(id)).slice(0, 4);
    }
    previous = [...turn.ids];
  }
  result.excludeIds = [...new Set(result.excludeIds.filter(Boolean))];
  return result;
}
