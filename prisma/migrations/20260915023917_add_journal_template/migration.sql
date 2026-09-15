-- AlterEnum
ALTER TYPE "DocumentType" ADD VALUE 'journal_template';

-- AlterTable
ALTER TABLE "User" ADD COLUMN     "journalTemplate" TEXT,
ADD COLUMN     "journalTemplateVersion" INTEGER NOT NULL DEFAULT 1;
