export const config = {
  databaseUrl: Deno.env.get("DATABASE_URL") ?? "",
  appUrl: Deno.env.get("APP_URL") ?? "http://localhost:8000",
  maxUploadBytes: 10 * 1024 * 1024, // 10 MB
};
