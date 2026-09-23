export type IndexStatus = 'pending' | 'indexing' | 'ready' | 'failed' | 'disabled' | 'excluded';
export interface SourceChunk {
  id: string; itemId: string; position: number; heading: string; text: string;
  kind: 'overview' | 'body'; sourceHash: string; start: number; end: number;
}
export interface SourceIndex {
  itemId: string; sourceHash: string; contentVersion: number; updatedAt: string;
  status: IndexStatus; chunkCount: number; contentState: 'body' | 'summary' | 'link';
  embeddingKey?: string; vectorCount: number; error?: string; lastAttemptRevision?: number;
}
export interface ChunkVector {
  id: string; itemId: string; chunkId: string; sourceHash: string; embeddingKey: string;
  dimensions: number; values: number[];
}
export interface IndexOverview {
  total: number; ready: number; pending: number; failed: number; excluded: number;
  chunks: number; vectors: number; linkOnly: number; running: boolean;
}
