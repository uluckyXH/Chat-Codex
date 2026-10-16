import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const npmCli = process.env.npm_execpath;
assert.ok(npmCli, "Run this check with npm run test:package [-- --keep].");
assert.ok(process.argv.slice(2).every((arg) => arg === "--keep"), "Only --keep is supported.");
const keep = process.argv.includes("--keep");
const temp = fs.mkdtempSync(path.join(os.tmpdir(), "chat-codex-package-"));
const cache = path.join(temp, "cache");
const prefix = path.join(temp, "install");
const packageJson = readJson(path.join(root, "package.json"));
const shrinkwrap = readJson(path.join(root, "npm-shrinkwrap.json"));
const checks = [];
let passed = false;

try {
  assert.equal(packageJson.version, shrinkwrap.version);
  assert.equal(packageJson.version, shrinkwrap.packages[""].version);
  checks.push("package.json and shrinkwrap versions match");

  // Packing runs the real prepack build and bundled-SDK metadata patch.
  const packedOutput = npm(["pack", "--json", "--pack-destination", temp], root);
  const json = packedOutput.match(/\[\s*\{[\s\S]*\}\s*\]\s*$/)?.[0];
  assert.ok(json, "npm pack did not return its JSON manifest");
  const [packed] = JSON.parse(json);
  assert.equal(packed.name, packageJson.name);
  assert.equal(packed.version, packageJson.version);
  const files = packed.files.map((entry) => entry.path);
  const rootFiles = new Set(["package.json", "npm-shrinkwrap.json", "LICENSE", "README.md", "README.zh-CN.md", "README.en.md"]);
  for (const file of files) {
    assert.ok(rootFiles.has(file) || /^dist\/src\/.+\.js$/.test(file) || file.startsWith("node_modules/"), `Unexpected published file: ${file}`);
    assert.ok(!/(^|\/)(\.env(?:\..*)?|\.npmrc|[^/]+\.(?:token|session|cookies)\.json)$/.test(file), `Sensitive file in package: ${file}`);
  }
  for (const file of rootFiles) assert.ok(files.includes(file), `Missing package file: ${file}`);
  checks.push("package allowlist excludes tests, references, state, logs and credentials");

  const expectedModules = sourceModules(path.join(root, "src"))
    .map((file) => `dist/${path.relative(root, file).replaceAll(path.sep, "/").replace(/\.tsx?$/, ".js")}`)
    .sort();
  const publishedModules = files.filter((file) => file.startsWith("dist/src/")).sort();
  assert.deepEqual(publishedModules, expectedModules, "Runtime modules must be complete, with no stale compiled files");
  assert.ok(files.includes(packageJson.bin[packageJson.name]));
  checks.push(`all ${expectedModules.length} runtime modules and the CLI entry point are packaged`);

  const tarball = path.join(temp, packed.filename);
  const bytes = fs.readFileSync(tarball);
  const integrity = `sha512-${createHash("sha512").update(bytes).digest("base64")}`;
  assert.equal(integrity, packed.integrity);
  checks.push("tarball SHA-512 matches the pack manifest");

  npm(["install", "--global", "--prefix", prefix, "--no-audit", "--no-fund", tarball], temp);
  npm(["ls", "--global", "--prefix", prefix, "--all", "--json"], temp);
  const installed = path.join(prefix, ...(process.platform === "win32" ? [] : ["lib"]), "node_modules", packageJson.name);
  assert.equal(readJson(path.join(installed, "package.json")).version, packageJson.version);
  checks.push("isolated tarball installation has a valid dependency tree");

  const cli = path.join(installed, packageJson.bin[packageJson.name]);
  assert.equal(run(process.execPath, [cli, "--version"], temp).trim(), packageJson.version);
  assert.match(run(process.execPath, [cli, "version"], temp), new RegExp(`Chat-Codex ${packageJson.version.replaceAll(".", "\\.")}`));
  assert.match(run(process.execPath, [cli, "--help"], temp), /chat-codex/);
  if (process.platform !== "win32") {
    assert.equal(run(path.join(prefix, "bin", packageJson.name), ["--version"], temp).trim(), packageJson.version);
  }
  checks.push("installed CLI version, version summary, help and executable entry work");

  const requireInstalled = createRequire(path.join(installed, "package.json"));
  const sdk = requireInstalled("@larksuiteoapi/node-sdk");
  assert.equal(typeof sdk.Client, "function");
  const dependencies = {};
  for (const name of ["@larksuiteoapi/node-sdk", "axios", "qs"]) {
    dependencies[name] = requireInstalled(`${name}/package.json`).version;
    assert.equal(dependencies[name], shrinkwrap.packages[`node_modules/${name}`].version);
  }
  checks.push("bundled Feishu SDK loads and installed SDK/axios/qs versions match shrinkwrap");

  const modules = [
    "codex/app-server/turn-controller.js", "codex/app-server/assistant-messages.js",
    "bridge/commentary-delivery.js", "bridge/pending-input.js", "group-access/service.js",
    "channels/weixin/weixin-adapter.js", "channels/weixin/weixin-quote-store.js",
    "channels/weixin/weixin-quotes.js", "channels/feishu/feishu-adapter.js", "channels/feishu/feishu-quotes.js",
  ];
  run(process.execPath, ["--input-type=module", "-e", `
    import { pathToFileURL } from 'node:url';
    for (const file of ${JSON.stringify(modules.map((file) => path.join(installed, "dist/src", file)))}) {
      const module = await import(pathToFileURL(file).href);
      if (Object.keys(module).length === 0) throw new Error('Missing exports: ' + file);
    }
  `], temp);
  checks.push("10 protocol, commentary, question, group and channel modules load from the installed package");

  const result = { name: packed.name, version: packed.version, checks, dependencies, size: packed.size, unpackedSize: packed.unpackedSize, entryCount: packed.entryCount, runtimeModules: expectedModules.length, integrity, shasum: packed.shasum, ...(keep ? { tarball, installPrefix: prefix } : {}) };
  fs.writeFileSync(path.join(temp, "result.json"), `${JSON.stringify(result, null, 2)}\n`);
  console.log(JSON.stringify(result, null, 2));
  passed = true;
} finally {
  if (passed && !keep) fs.rmSync(temp, { recursive: true, force: true });
  else console.error(`Package test artifacts: ${temp}`);
}

function readJson(file) { return JSON.parse(fs.readFileSync(file, "utf8")); }
function run(executable, args, cwd) {
  try {
    return execFileSync(executable, args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], maxBuffer: 20 * 1024 * 1024, timeout: 180_000 });
  } catch (error) {
    if (error.stdout) process.stderr.write(error.stdout);
    if (error.stderr) process.stderr.write(error.stderr);
    throw error;
  }
}
function npm(args, cwd) {
  return run(process.execPath, [npmCli, "--cache", cache, "--registry", "https://registry.npmjs.org", ...args], cwd);
}
function sourceModules(directory) {
  return fs.readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const file = path.join(directory, entry.name);
    if (entry.isDirectory()) return sourceModules(file);
    return /\.tsx?$/.test(entry.name) && !entry.name.endsWith(".d.ts") ? [file] : [];
  });
}
