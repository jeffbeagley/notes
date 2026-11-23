ALTER TABLE "ExternalImport" ADD COLUMN "indexedAt" TIMESTAMP(3);
ALTER TABLE "Media" ADD COLUMN "stagedImportKey" TEXT;
CREATE INDEX "Media_userId_stagedImportKey_idx" ON "Media"("userId", "stagedImportKey");
