#!/usr/bin/env -S deno run -A
/**
 * Build script for publishing the CLI to npm as mcp-stress
 * Creates platform-specific packages:
 *   mcp-stress                          - Main package with wrapper (tiny)
 *   @mcp-stress/linux-x64               - Linux x64 binary
 *   @mcp-stress/linux-arm64             - Linux ARM64 binary
 *   @mcp-stress/darwin-x64              - macOS Intel binary
 *   @mcp-stress/darwin-arm64            - macOS Apple Silicon binary
 *   @mcp-stress/win32-x64              - Windows x64 binary
 *
 * Usage:
 *   deno run -A scripts/build_npm.ts              # Build all platforms
 *   deno run -A scripts/build_npm.ts --platform linux-x64  # Build one
 */

const args = parseFlags(Deno.args);

const denoJson = JSON.parse(await Deno.readTextFile("./deno.json"));
const version = denoJson.version;

if (!version) {
  console.error("Error: No version in deno.json");
  Deno.exit(1);
}

console.log(`Building mcp-stress version ${version}...`);

try {
  await Deno.remove("./npm", { recursive: true });
} catch { /* doesn't exist */ }

const allPlatforms = [
  {
    target: "x86_64-unknown-linux-gnu",
    pkg: "@mcp-stress/linux-x64",
    os: "linux",
    cpu: "x64",
    bin: "mcp-stress",
  },
  {
    target: "aarch64-unknown-linux-gnu",
    pkg: "@mcp-stress/linux-arm64",
    os: "linux",
    cpu: "arm64",
    bin: "mcp-stress",
  },
  {
    target: "x86_64-apple-darwin",
    pkg: "@mcp-stress/darwin-x64",
    os: "darwin",
    cpu: "x64",
    bin: "mcp-stress",
  },
  {
    target: "aarch64-apple-darwin",
    pkg: "@mcp-stress/darwin-arm64",
    os: "darwin",
    cpu: "arm64",
    bin: "mcp-stress",
  },
  {
    target: "x86_64-pc-windows-msvc",
    pkg: "@mcp-stress/win32-x64",
    os: "win32",
    cpu: "x64",
    bin: "mcp-stress.exe",
  },
];

const platforms = args.platform
  ? allPlatforms.filter((p) => `${p.os}-${p.cpu}` === args.platform)
  : allPlatforms;

if (platforms.length === 0) {
  console.error(`Unknown platform "${args.platform}"`);
  Deno.exit(1);
}

for (const platform of platforms) {
  const dirName = platform.pkg.replace("@mcp-stress/", "");
  const pkgDir = `./npm/${dirName}`;
  await Deno.mkdir(`${pkgDir}/bin`, { recursive: true });

  console.log(`Compiling for ${platform.target}...`);
  const cmd = new Deno.Command("deno", {
    args: [
      "compile",
      "-A",
      "--include",
      "src/dashboard/templates/",
      "--include",
      "src/metrics/writer_worker.ts",
      "--target",
      platform.target,
      "--output",
      `${pkgDir}/bin/${platform.bin}`,
      "./src/main.ts",
    ],
    stdout: "inherit",
    stderr: "inherit",
  });

  const result = await cmd.output();
  if (!result.success) {
    console.error(`Failed to compile for ${platform.target}`);
    Deno.exit(1);
  }

  await Deno.writeTextFile(
    `${pkgDir}/package.json`,
    JSON.stringify(
      {
        name: platform.pkg,
        version,
        description:
          `Platform binary for mcp-stress (${platform.os}-${platform.cpu})`,
        license: "MIT",
        repository: {
          type: "git",
          url: "git+https://github.com/dgellow/mcp-stress.git",
        },
        os: [platform.os],
        cpu: [platform.cpu],
      },
      null,
      2,
    ) + "\n",
  );

  const stat = await Deno.stat(`${pkgDir}/bin/${platform.bin}`);
  console.log(
    `  ${platform.pkg}: ${(stat.size / 1024 / 1024).toFixed(1)} MB`,
  );
}

// Main package
console.log("\nCreating main mcp-stress package...");
const mainDir = "./npm/mcp-stress";
await Deno.mkdir(mainDir, { recursive: true });

await Deno.writeTextFile(
  `${mainDir}/mcp-stress.js`,
  `#!/usr/bin/env node
const { spawn } = require("child_process");
const path = require("path");
const fs = require("fs");
const os = require("os");

const PLATFORMS = {
  "linux-x64": "linux-x64",
  "linux-arm64": "linux-arm64",
  "darwin-x64": "darwin-x64",
  "darwin-arm64": "darwin-arm64",
  "win32-x64": "win32-x64",
};

const key = \`\${process.platform}-\${process.arch}\`;
const pkgSuffix = PLATFORMS[key];

if (!pkgSuffix) {
  console.error(\`Unsupported platform: \${key}\`);
  console.error("Use Deno instead: deno install -g -A --name mcp-stress jsr:@dgellow/mcp-stress/cli");
  process.exit(1);
}

const binName = process.platform === "win32" ? "mcp-stress.exe" : "mcp-stress";
let binPath;

for (const loc of [
  path.join(__dirname, "..", pkgSuffix, "bin", binName),
  path.join(__dirname, "..", "..", pkgSuffix, "bin", binName),
]) {
  if (fs.existsSync(loc)) { binPath = loc; break; }
}

if (!binPath) {
  try {
    binPath = path.join(path.dirname(require.resolve(\`@mcp-stress/\${pkgSuffix}/package.json\`)), "bin", binName);
  } catch {
    console.error(\`Binary not found for \${key}. Try: npm install mcp-stress\`);
    process.exit(1);
  }
}

const child = spawn(binPath, process.argv.slice(2), { stdio: "inherit" });
child.on("error", (err) => { console.error(\`Failed to start mcp-stress: \${err.message}\`); process.exit(1); });
for (const sig of Object.keys(os.constants.signals)) { try { process.on(sig, () => child.kill(sig)); } catch {} }
child.on("exit", (code, signal) => { if (signal) process.kill(process.pid, signal); else process.exit(code ?? 0); });
`,
);

await Deno.writeTextFile(
  `${mainDir}/package.json`,
  JSON.stringify(
    {
      name: "mcp-stress",
      version,
      description: "Stress testing tool for MCP servers",
      license: "MIT",
      repository: {
        type: "git",
        url: "git+https://github.com/dgellow/mcp-stress.git",
      },
      bugs: { url: "https://github.com/dgellow/mcp-stress/issues" },
      homepage: "https://github.com/dgellow/mcp-stress#readme",
      keywords: [
        "mcp",
        "stress-test",
        "load-test",
        "benchmark",
        "model-context-protocol",
        "cli",
      ],
      bin: { "mcp-stress": "./mcp-stress.js" },
      files: ["mcp-stress.js"],
      optionalDependencies: {
        "@mcp-stress/linux-x64": version,
        "@mcp-stress/linux-arm64": version,
        "@mcp-stress/darwin-x64": version,
        "@mcp-stress/darwin-arm64": version,
        "@mcp-stress/win32-x64": version,
      },
    },
    null,
    2,
  ) + "\n",
);

await Deno.copyFile("LICENSE", `${mainDir}/LICENSE`);
await Deno.copyFile("README.md", `${mainDir}/README.md`);

console.log("\nBuild complete! Output in ./npm");

function parseFlags(args: string[]): { platform?: string } {
  const idx = args.indexOf("--platform");
  return { platform: idx >= 0 ? args[idx + 1] : undefined };
}
