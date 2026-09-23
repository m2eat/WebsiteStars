import type { ChatStopTarget } from './chat-types';

export type Source = 'github' | 'article' | 'docs';
export type AnalysisStatus = 'disabled' | 'pending' | 'running' | 'succeeded' | 'failed';
export interface Analysis {
  summary: string; category: string; tags: string[]; keywords: string[];
  stack: string[]; useCases: string[]; provider: string; model: string; analyzedAt: string;
}
export interface GithubMetadata {
  repoId?: number; owner: string; repo: string; language: string; license: string;
  stars: number; topics: string[]; fetchedAt: string;
}
export interface Item {
  id: string; url: string; normalizedUrl: string; title: string; description: string;
  excerpt: string; content: string; truncated: boolean; source: Source; domain: string;
  author: string; publishedAt: string; tags: string[]; keywords: string[]; category: string;
  notes: string; selections: string[]; summaryOverride?: string; tagsOverride?: string[];
  categoryOverride?: string; ai?: Analysis; analysisStatus: AnalysisStatus; analysisError?: string;
  github?: GithubMetadata; githubVisibility?: 'public' | 'private'; createdAt: string; updatedAt: string; contentVersion: number;
}
export interface Capture {
  url: string; title?: string; canonicalUrl?: string; description?: string; excerpt?: string;
  content?: string; truncated?: boolean; source?: Source; author?: string; publishedAt?: string;
  selection?: string; tags?: string[]; keywords?: string[]; github?: GithubMetadata;
}
export interface ItemPatch {
  title?: string; notes?: string; summaryOverride?: string; tagsOverride?: string[]; categoryOverride?: string;
}
export interface Settings {
  aiEnabled: boolean; queryEnabled: boolean; provider: 'compatible' | 'workers-ai'; endpoint: string; model: string;
  apiKey: string; accountId: string; githubToken: string; retainContent: boolean;
  blockedDomains: string[]; revision: number; floatingEnabled: boolean;
  modelTimeoutSeconds: number; queryTimeoutSeconds: number;
  semanticEnabled: boolean; embeddingEndpoint: string; embeddingModel: string; embeddingApiKey: string; localNotesSearch: boolean;
}
export const DEFAULT_SETTINGS: Settings = {
  aiEnabled: false, queryEnabled: false, provider: 'compatible', endpoint: 'https://api.x.ai/v1', model: 'grok-4.5',
  apiKey: '', accountId: '', githubToken: '', retainContent: true, blockedDomains: [], revision: 0, floatingEnabled: true,
  modelTimeoutSeconds: 180, queryTimeoutSeconds: 900,
  semanticEnabled: false, embeddingEndpoint: '', embeddingModel: '', embeddingApiKey: '', localNotesSearch: false,
};
export interface Job {
  itemId: string; contentVersion: number; settingsRevision: number; status: 'pending' | 'running';
  attempts: number; nextAttempt: number; leaseUntil: number;
  kind?: 'analysis' | 'github'; analyzeAfter?: boolean; leaseId?: string;
}
export interface Filters {
  query: string; source: 'all' | Source; tag: string; category: string; language: string;
  sort: 'recent' | 'name' | 'stars';
}
export type ModelConnection = Pick<Settings, 'provider' | 'endpoint' | 'apiKey' | 'accountId' | 'modelTimeoutSeconds'>;
export interface AvailableModel { id: string; name: string }
export interface ModelList { models: AvailableModel[]; truncated: boolean }
export type Command =
  | { type: 'getIndexOverview' }
  | { type: 'rebuildIndexes' }
  | { type: 'testEmbeddingConnection' }
  | { type: 'listModels'; connection: ModelConnection }
  | { type: 'createChat' }
  | { type: 'deleteChat'; id: string }
  | { type: 'stopChat'; id: string; target: ChatStopTarget }
  | { type: 'testQueryConnection' }
  | { type: 'capturePage' }
  | { type: 'getPageState' }
  | { type: 'captureTab'; tabId?: number }
  | { type: 'saveUrl'; url: string; title?: string; notes?: string }
  | { type: 'updateItem'; id: string; patch: ItemPatch }
  | { type: 'deleteItem'; id: string }
  | { type: 'analyze'; id: string }
  | { type: 'refresh'; id: string }
  | { type: 'getSettings' }
  | { type: 'saveSettings'; settings: Settings }
  | { type: 'exportBackup' }
  | { type: 'importBackup'; text: string }
  | { type: 'saveGithub'; url: string };
export type Reply<T> = { ok: true; data: T } | { ok: false; error: string };
