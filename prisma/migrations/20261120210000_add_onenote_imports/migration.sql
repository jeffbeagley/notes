CREATE TABLE "ExternalImport" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "provider" TEXT NOT NULL,
    "sourceId" TEXT NOT NULL,
    "noteId" TEXT NOT NULL,

    CONSTRAINT "ExternalImport_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "ExternalImport_noteId_key" ON "ExternalImport"("noteId");
CREATE UNIQUE INDEX "ExternalImport_userId_provider_sourceId_key" ON "ExternalImport"("userId", "provider", "sourceId");
CREATE INDEX "ExternalImport_userId_provider_idx" ON "ExternalImport"("userId", "provider");

ALTER TABLE "ExternalImport" ADD CONSTRAINT "ExternalImport_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "ExternalImport" ADD CONSTRAINT "ExternalImport_noteId_fkey" FOREIGN KEY ("noteId") REFERENCES "Note"("id") ON DELETE CASCADE ON UPDATE CASCADE;
