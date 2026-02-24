import process from "node:process";
import { defineConfig } from "prisma/config";

const databaseUrl =
  (globalThis as unknown as { Deno?: { env: { get: (k: string) => string } } })
    .Deno?.env.get("DATABASE_URL") ?? process.env.DATABASE_URL ?? "";

export default defineConfig({
  schema: "prisma/schema.prisma",
  migrations: {
    path: "prisma/migrations",
  },
  datasource: {
    url: databaseUrl,
  },
});
