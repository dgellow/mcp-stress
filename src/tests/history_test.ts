import { assertEquals, assertRejects } from "@std/assert";
import {
  ensureRunsDir,
  looksLikeFilePath,
  resolveRunPath,
  runExists,
  runPath,
  validateRunName,
} from "../history.ts";

// ─── validateRunName ───

Deno.test("validateRunName: accepts valid names", () => {
  assertEquals(validateRunName("baseline"), null);
  assertEquals(validateRunName("after-fix"), null);
  assertEquals(validateRunName("run_001"), null);
  assertEquals(validateRunName("A-Z-0-9_test"), null);
});

Deno.test("validateRunName: rejects path separators", () => {
  assertEquals(
    validateRunName("foo/bar"),
    "Name cannot contain path separators",
  );
  assertEquals(
    validateRunName("foo\\bar"),
    "Name cannot contain path separators",
  );
});

Deno.test("validateRunName: rejects .ndjson suffix", () => {
  assertEquals(
    validateRunName("baseline.ndjson"),
    "Name should not include .ndjson extension",
  );
});

Deno.test("validateRunName: rejects special characters", () => {
  assertEquals(
    validateRunName("my run"),
    "Name must contain only letters, digits, hyphens, and underscores",
  );
  assertEquals(
    validateRunName("test@2"),
    "Name must contain only letters, digits, hyphens, and underscores",
  );
  assertEquals(
    validateRunName("résultat"),
    "Name must contain only letters, digits, hyphens, and underscores",
  );
});

// ─── looksLikeFilePath ───

Deno.test("looksLikeFilePath: bare names are not file paths", () => {
  assertEquals(looksLikeFilePath("baseline"), false);
  assertEquals(looksLikeFilePath("after-fix"), false);
  assertEquals(looksLikeFilePath("run_001"), false);
});

Deno.test("looksLikeFilePath: paths with slashes are file paths", () => {
  assertEquals(looksLikeFilePath("./baseline.ndjson"), true);
  assertEquals(looksLikeFilePath("/tmp/run.ndjson"), true);
  assertEquals(looksLikeFilePath("results/baseline.ndjson"), true);
});

Deno.test("looksLikeFilePath: dotted filenames are file paths", () => {
  assertEquals(looksLikeFilePath("baseline.ndjson"), true);
  assertEquals(looksLikeFilePath("run.1.ndjson"), true);
});

// ─── resolveRunPath ───

Deno.test("resolveRunPath: file paths pass through unchanged", async () => {
  const tmpDir = await Deno.makeTempDir();
  try {
    const result = await resolveRunPath(tmpDir, "./some/file.ndjson");
    assertEquals(result, "./some/file.ndjson");
  } finally {
    await Deno.remove(tmpDir, { recursive: true });
  }
});

Deno.test("resolveRunPath: unknown name throws", async () => {
  const tmpDir = await Deno.makeTempDir();
  try {
    await assertRejects(
      () => resolveRunPath(tmpDir, "nonexistent-run-xyz"),
      Error,
      'No saved run named "nonexistent-run-xyz"',
    );
  } finally {
    await Deno.remove(tmpDir, { recursive: true });
  }
});

Deno.test("resolveRunPath: resolves existing named run", async () => {
  const tmpDir = await Deno.makeTempDir();
  const testPath = runPath(tmpDir, "my-run");
  await Deno.writeTextFile(testPath, "{}");

  try {
    const resolved = await resolveRunPath(tmpDir, "my-run");
    assertEquals(resolved, testPath);
  } finally {
    await Deno.remove(tmpDir, { recursive: true });
  }
});

// ─── runExists ───

Deno.test("runExists: returns false for missing run", async () => {
  const tmpDir = await Deno.makeTempDir();
  try {
    assertEquals(await runExists(tmpDir, "nope"), false);
  } finally {
    await Deno.remove(tmpDir, { recursive: true });
  }
});

Deno.test("runExists: returns true for existing run", async () => {
  const tmpDir = await Deno.makeTempDir();
  const testPath = runPath(tmpDir, "exists");
  await Deno.writeTextFile(testPath, "{}");

  try {
    assertEquals(await runExists(tmpDir, "exists"), true);
  } finally {
    await Deno.remove(tmpDir, { recursive: true });
  }
});

// ─── ensureRunsDir ───

Deno.test("ensureRunsDir: creates nested directory", async () => {
  const tmpDir = await Deno.makeTempDir();
  try {
    const dir = await ensureRunsDir(tmpDir);
    const stat = await Deno.stat(dir);
    assertEquals(stat.isDirectory, true);
    assertEquals(dir.endsWith(".mcp-stress/runs"), true);
  } finally {
    await Deno.remove(tmpDir, { recursive: true });
  }
});
