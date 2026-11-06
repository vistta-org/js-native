import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { promisify } from "node:util";

const exec = promisify(execFile);
const packageDir = fileURLToPath(new URL("../", import.meta.url));
const npmCli = process.env.npm_execpath;
assert.ok(npmCli, "Run this check through npm run test:package or npm run test:native.");
if (process.argv.includes("--consumer")) {
  await checkConsumer(process.argv.at(-1));
} else {
  const root = await mkdtemp(path.join(tmpdir(), "vistta-native-consumer-"));
  const previousCwd = process.cwd();
  const previousEnv = process.env.NODE_ENV;

  try {
    const { stdout } = await exec(
      process.execPath,
      [npmCli, "pack", packageDir, "--json", "--ignore-scripts", "--pack-destination", root],
      {
        cwd: root,
        maxBuffer: 8 * 1024 * 1024,
      },
    );
    const [packed] = JSON.parse(stdout);
    assert.ok(packed.files.length < 500, "Unexpectedly large package file count");
    const forbidden =
      /(^|\/)(target|\.tauri|\.gradle|\.build)(\/|$)|android\/build\/|\.(keystore|jks)$|android\.keystore\.properties$/;
    assert.deepEqual(
      packed.files.filter(({ path: file }) => forbidden.test(file)),
      [],
      "Package contains build outputs or signing secrets",
    );
    for (const required of [
      "index.js",
      "plugins/index.js",
      "rust/build.rs",
      "rust/plugins/core/src/lib.rs",
      "rust/plugins/directory-sync/src/lib.rs",
    ]) {
      assert.ok(
        packed.files.some(({ path: file }) => file === required),
        `Missing runtime source: ${required}`,
      );
    }

    const manifest = JSON.parse(await readFile(path.join(packageDir, "package.json"), "utf8"));
    const consumer = path.join(root, "consumer");
    await mkdir(consumer);
    await writeFile(
      path.join(consumer, "package.json"),
      JSON.stringify({
        name: "native-consumer-smoke",
        version: "0.0.1",
        type: "module",
        private: true,
      }),
    );
    const installed = await exec(
      process.execPath,
      [
        npmCli,
        "install",
        path.join(root, packed.filename),
        `sharp@${manifest.peerDependencies.sharp}`,
        `socket.io-client@${manifest.peerDependencies["socket.io-client"]}`,
        "--ignore-scripts",
        "--legacy-peer-deps",
        "--no-audit",
        "--no-fund",
      ],
      {
        cwd: consumer,
        maxBuffer: 8 * 1024 * 1024,
      },
    );
    if (installed.stdout.trim()) console.log(installed.stdout.trim());

    console.log(`Packed archive verified (${packed.files.length} files, ${packed.size} bytes).`);
    await new Promise((resolve, reject) => {
      const child = spawn(
        process.execPath,
        [fileURLToPath(import.meta.url), ...(process.argv.includes("--native") ? ["--native"] : []), "--consumer", consumer],
        {
          cwd: consumer,
          stdio: "inherit",
          env: { ...process.env, NODE_ENV: "production" },
        },
      );
      child.once("error", reject);
      child.once("close", (code) =>
        code === 0 ? resolve() : reject(new Error(`Packed consumer exited with code ${code}`)),
      );
    });
  } finally {
    process.chdir(previousCwd);
    if (previousEnv === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = previousEnv;
    await rm(root, { recursive: true, force: true });
  }
}

async function checkConsumer(consumer) {
  process.chdir(consumer);
  process.env.NODE_ENV = "production";
  const installedDir = path.join(consumer, "node_modules/@vistta/js-native");
  const runtime = await import(pathToFileURL(path.join(installedDir, "index.js")).href);
  const plugins = await import(pathToFileURL(path.join(installedDir, "plugins/index.js")).href);
  assert.equal(runtime.Tauri.run, runtime.run);
  assert.equal(runtime.Tauri.build, runtime.build);
  assert.equal(typeof plugins.Accessibility.setShortcuts, "function");
  assert.equal(typeof plugins.Notification.requestPermission, "function");
  const info = await runtime.getInfo({ app: { name: "native-smoke" } });
  assert.equal(info.version, "0.0.1");
  console.log("Packed consumer imports passed.");

  if (process.argv.includes("--native")) {
    const buildDir = path.join(consumer, "build");
    await mkdir(path.join(buildDir, "www"), { recursive: true });
    await writeFile(
      path.join(buildDir, "www/index.html"),
      "<!doctype html><html><head><title>Native smoke</title></head><body>Native smoke</body></html>",
    );
    const result = await runtime.build({
      platform: "desktop",
      buildDir,
      app: { id: "org.vistta.native.smoke", name: "native-smoke" },
      extraTauriConfig: { bundle: { active: false } },
    });
    assert.equal(result.type, "release");
    const binary = result.paths.at(-1);
    assert.ok((await stat(binary)).size > 0, "Native build did not produce a binary");
    console.log("Packed consumer desktop release build passed.");
  }
}
