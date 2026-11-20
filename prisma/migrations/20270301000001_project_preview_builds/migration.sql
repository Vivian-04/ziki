


-- AlterTable
ALTER TABLE "ProjectPreviewSettings" ADD COLUMN     "mainCheckedAt" TIMESTAMP(3);

-- CreateTable
CREATE TABLE "ProjectPreviewBuild" (
    "id" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "repository" TEXT NOT NULL,
    "branch" TEXT NOT NULL,
    "headSha" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'queued',
    "runId" TEXT,
    "runUrl" TEXT,
    "url" TEXT,
    "error" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "completedAt" TIMESTAMP(3),

    CONSTRAINT "ProjectPreviewBuild_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "ProjectPreviewBuild_status_updatedAt_idx" ON "ProjectPreviewBuild"("status", "updatedAt");

-- CreateIndex
CREATE INDEX "ProjectPreviewBuild_projectId_createdAt_idx" ON "ProjectPreviewBuild"("projectId", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "ProjectPreviewBuild_projectId_headSha_key" ON "ProjectPreviewBuild"("projectId", "headSha");

-- AddForeignKey
ALTER TABLE "ProjectPreviewBuild" ADD CONSTRAINT "ProjectPreviewBuild_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE CASCADE ON UPDATE CASCADE;
