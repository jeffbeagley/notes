-- AlterTable
ALTER TABLE "ContextChunk" ADD COLUMN     "embedding" DOUBLE PRECISION[] DEFAULT ARRAY[]::DOUBLE PRECISION[];

-- Full-text search index over title/heading/content, used regardless of whether an LLM is configured.
CREATE INDEX "ContextChunk_fts_idx" ON "ContextChunk" USING GIN (
  to_tsvector('english', title || ' ' || coalesce(heading, '') || ' ' || content)
);
