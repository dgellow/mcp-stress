import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "@/prisma/generated/client.ts";

const adapter = new PrismaPg({
  connectionString: Deno.env.get("DATABASE_URL"),
});

export const prisma = new PrismaClient({ adapter });
