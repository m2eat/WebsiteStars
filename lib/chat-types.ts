import type { UIMessage, UIMessageChunk } from 'ai';

export type ChatStatus = 'idle' | 'running' | 'completed' | 'stopped' | 'failed' | 'interrupted';
export interface ChatSession {
  id: string; title: string; createdAt: string; updatedAt: string;
  status: ChatStatus; activeRunId?: string; error?: string;
}
export interface ChatCitation {
  itemId: string; title: string; url: string; source: string;
  quote: string; reason: string; contentVersion: number; kind?: 'identity' | 'capability';
}
export interface ChatMessage {
  id: string; sessionId: string; runId?: string; role: 'user' | 'assistant';
  text: string; createdAt: string; sequence: number; status: ChatStatus;
  citations: ChatCitation[]; error?: string;
}
export interface ChatRun {
  id: string; sessionId: string; userMessageId: string; assistantMessageId: string; clientRequestId?: string;
  status: ChatStatus; phase: string; startedAt: string; updatedAt: string;
  settingsRevision: number; provider: string; model: string; error?: string;
  inputTokens?: number; outputTokens?: number;
  steps: ChatStep[];
}
export interface ChatStep {
  tool: string; label: string; resultIds: string[]; durationMs: number; at: string; retrievalMode?: 'lexical' | 'hybrid' | 'fallback'; warning?: string;
}
export type ChatUIMessage = UIMessage;
export const CHAT_PORT = 'starts-agent-query';
export type ChatStopTarget = { requestId: string; runId?: never } | { runId: string; requestId?: never };
export type ChatPortRequest =
  | { type: 'send'; sessionId: string; text: string; messageId: string; requestId: string }
  | { type: 'retry'; sessionId: string; messageId: string; requestId: string }
  | { type: 'stop'; sessionId: string; target: ChatStopTarget };
export type ChatPortReply = { type: 'chunk'; chunk: UIMessageChunk } | { type: 'end' } | { type: 'error'; error: string };
export interface AgentHistoryTurn { question: string; answer: string; itemIds: string[] }
export interface AgentResult { text: string; citations: ChatCitation[]; inputTokens?: number; outputTokens?: number }
