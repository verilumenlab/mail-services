import "dotenv/config";
import { defineConfig } from "prisma/config";

function cleanUrl(url?: string): string {
  if (!url) {
    throw new Error("DATABASE_URL (or DATABASE_URL_UNPOOLED) is required for Prisma CLI.");
  }
  let clean = url.trim();
  if ((clean.startsWith('"') && clean.endsWith('"')) || (clean.startsWith("'") && clean.endsWith("'"))) {
    clean = clean.slice(1, -1).trim();
  }
  if (clean.startsWith("DATABASE_URL=")) {
    clean = clean.slice("DATABASE_URL=".length).trim();
  }
  if (!clean.startsWith("postgres")) {
    throw new Error("DATABASE_URL must be a postgresql:// connection string.");
  }
  return clean;
}

export default defineConfig({
  schema: "prisma/schema.prisma",
  migrations: {
    path: "prisma/migrations",
  },
  datasource: {
    // Prefer direct (unpooled) for migrations; fall back to pooled DATABASE_URL.
    url: cleanUrl(process.env.DATABASE_URL_UNPOOLED || process.env.DATABASE_URL),
  },
});
