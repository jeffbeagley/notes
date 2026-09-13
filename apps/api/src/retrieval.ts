import type { PrismaClient } from '@prisma/client';
import { embeddingsAvailable, embedTexts } from './llm.js';

export type ScoredChunk = { id: string; documentId: string; documentType: string; title: string; heading: string | null; content: string; updatedAt: Date };

/// Postgres full-text search, always available regardless of LLM configuration.
export async function ftsChunkSearch(prisma: PrismaClient, userId: string, query: string, limit: number): Promise<ScoredChunk[]> {
  if (!query.trim()) return [];
  return prisma.$queryRaw<ScoredChunk[]>`
    SELECT id, "documentId", "documentType", title, heading, content, "updatedAt"
    FROM "ContextChunk"
    WHERE "userId" = ${userId}
      AND to_tsvector('english', title || ' ' || coalesce(heading, '') || ' ' || content) @@ websearch_to_tsquery('english', ${query})
    ORDER BY ts_rank(to_tsvector('english', title || ' ' || coalesce(heading, '') || ' ' || content), websearch_to_tsquery('english', ${query})) DESC
    LIMIT ${limit}
  `;
}

function cosineSimilarity(a: number[], b: number[]) {
  if (!a.length || a.length !== b.length) return 0;
  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < a.length; i += 1) {
    dot += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }
  if (!normA || !normB) return 0;
  return dot / (Math.sqrt(normA) * Math.sqrt(normB));
}

/// Semantic search over chunks that already have an embedding. Returns [] whenever no embeddings
/// model is configured (embedTexts returns null) or nothing has been embedded yet, so callers can
/// transparently fall back to full-text-only results.
export async function vectorChunkSearch(prisma: PrismaClient, userId: string, query: string, limit: number): Promise<ScoredChunk[]> {
  const [queryEmbedding] = (await embedTexts(prisma, [query])) ?? [];
  if (!queryEmbedding?.length) return [];
  const candidates = await prisma.contextChunk.findMany({
    where: { userId, embedding: { isEmpty: false } },
    select: { id: true, documentId: true, documentType: true, title: true, heading: true, content: true, updatedAt: true, embedding: true },
  });
  return candidates
    .map((chunk) => ({ ...chunk, score: cosineSimilarity(queryEmbedding, chunk.embedding) }))
    .sort((first, second) => second.score - first.score)
    .slice(0, limit);
}

/// Reciprocal rank fusion: merges the FTS and vector rankings without needing their scores to be
/// on a comparable scale. Each list contributes 1/(k + rank) per item; a chunk found by both ranks
/// higher than one found by only one method.
function fuseRankings(rankedLists: ScoredChunk[][], k = 60) {
  const scoreById = new Map<string, number>();
  const chunkById = new Map<string, ScoredChunk>();
  for (const list of rankedLists) {
    list.forEach((chunk, rank) => {
      scoreById.set(chunk.id, (scoreById.get(chunk.id) ?? 0) + 1 / (k + rank + 1));
      if (!chunkById.has(chunk.id)) chunkById.set(chunk.id, chunk);
    });
  }
  return [...chunkById.values()].sort((first, second) => (scoreById.get(second.id) ?? 0) - (scoreById.get(first.id) ?? 0));
}

/// Shared retrieval used by both the assistant's initial context stuffing and the search_notes tool
/// call it can make mid-conversation. Combines keyword (FTS) and, when configured, semantic (vector)
/// search via reciprocal rank fusion; falls back to recent chunks if neither method matches.
export async function hybridChunkSearch(prisma: PrismaClient, userId: string, query: string, limit: number): Promise<ScoredChunk[]> {
  const [ftsChunks, vectorChunks] = await Promise.all([
    ftsChunkSearch(prisma, userId, query, Math.max(limit, 20)),
    embeddingsAvailable(prisma).then((enabled) => (enabled ? vectorChunkSearch(prisma, userId, query, Math.max(limit, 20)) : [])),
  ]);
  if (!ftsChunks.length && !vectorChunks.length) return [];
  return fuseRankings([ftsChunks, vectorChunks]).slice(0, limit);
}
