-- CreateTable
CREATE TABLE "runs" (
    "id" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "meta" JSONB NOT NULL,
    "summary" JSONB NOT NULL,
    "ndjson" TEXT NOT NULL,
    "size_bytes" INTEGER NOT NULL,

    CONSTRAINT "runs_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "runs_created_at_idx" ON "runs"("created_at" DESC);
