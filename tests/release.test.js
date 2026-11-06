import assert from "node:assert/strict";
import childProcess from "node:child_process";
import { EventEmitter } from "node:events";
import { writeFileSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";
import test from "node:test";
import { patchCapabilities } from "../patches/capabilities.js";
import { PLUGINS } from "../plugins.config.js";
import { exec } from "../utils/index.js";

const previousEnv = process.env.NODE_ENV;
process.env.NODE_ENV = "production";
const { patchAppGradleSigning } = await import("../patches/android.js");
const { run, build, Tauri, TAURI_VERSION } = await import("../index.js");
if (previousEnv === undefined) delete process.env.NODE_ENV;
else process.env.NODE_ENV = previousEnv;

async function fixture(context) {
  const root = await mkdtemp(path.join(tmpdir(), "vistta-native-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  const app = path.join(root, "gen", "android", "app");
  await mkdir(app, { recursive: true });
  await writeFile(
    path.join(app, "build.gradle.kts"),
    'android {\n    buildTypes {\n        getByName("release") {\n        }\n    }\n}\n',
  );
  return { root, app };
}

function mockKeytool(context) {
  const calls = [];
  context.mock.method(childProcess, "spawn", (command, args, options) => {
    const child = new EventEmitter();
    calls.push({ command, args, options });
    queueMicrotask(() => {
      writeFileSync(args[args.indexOf("-keystore") + 1], "test keystore");
      child.emit("close", 0);
    });
    return child;
  });
  syncBuiltinESMExports();
  context.after(() => {
    context.mock.restoreAll();
    syncBuiltinESMExports();
  });
  return calls;
}

test("default plugins do not grant command execution", () => {
  assert.deepEqual(PLUGINS.find(({ id }) => id === "shell").permissions, []);
});

test("spawn errors reject instead of crashing and a late end resolves", async () => {
  await assert.rejects(exec("vistta-no-such-command", [], { stdio: "pipe" }).end(), { code: "ENOENT" });
  const child = exec(process.execPath, ["--version"], { stdio: "pipe" });
  await new Promise((resolve) => child.on("close", resolve));
  await child.end();
});

test("new keystore passwords are random, reused, and absent from commands and Gradle", async (context) => {
  const first = await fixture(context);
  const second = await fixture(context);
  const calls = mockKeytool(context);
  const config = { app: { id: "org.example.app" } };
  const firstEnv = await patchAppGradleSigning(first.root, config);
  const secondEnv = await patchAppGradleSigning(second.root, config);
  assert.match(firstEnv.VISTTA_ANDROID_STORE_PASSWORD, /^[a-f0-9]{64}$/);
  assert.notEqual(firstEnv.VISTTA_ANDROID_STORE_PASSWORD, secondEnv.VISTTA_ANDROID_STORE_PASSWORD);
  assert.deepEqual(await patchAppGradleSigning(first.root, config), firstEnv);
  assert.equal(calls.length, 2);
  for (const { command, args, options } of calls) {
    assert.equal(command, "keytool");
    assert.equal(options.shell, false);
    assert.equal(args.includes(options.env.VISTTA_ANDROID_STORE_PASSWORD), false);
    assert.equal(args.includes("-storepass:env"), true);
  }
  const gradle = await readFile(path.join(first.app, "build.gradle.kts"), "utf8");
  assert.equal(gradle.includes(firstEnv.VISTTA_ANDROID_STORE_PASSWORD), false);
  assert.match(gradle, /System.getenv\("VISTTA_ANDROID_STORE_PASSWORD"\)/);
  if (process.platform !== "win32") {
    assert.equal((await stat(path.join(first.root, "android.keystore.properties"))).mode & 0o777, 0o600);
    assert.equal((await stat(path.join(first.app, "release.keystore"))).mode & 0o777, 0o600);
  }
});

test("explicit signing secrets are required and only returned through environment", async (context) => {
  const { root, app } = await fixture(context);
  const keystore = path.join(root, "provided.jks");
  await writeFile(keystore, "provided key");
  const secret = 'private $value "with quotes"';
  const signingEnv = await patchAppGradleSigning(root, { keystore: { file: keystore, password: secret } });
  assert.equal(signingEnv.VISTTA_ANDROID_STORE_PASSWORD, secret);
  assert.equal((await readFile(path.join(app, "build.gradle.kts"), "utf8")).includes(secret), false);
  const password = process.env.ANDROID_KEYSTORE_PASSWORD;
  delete process.env.ANDROID_KEYSTORE_PASSWORD;
  context.after(() => {
    if (password === undefined) delete process.env.ANDROID_KEYSTORE_PASSWORD;
    else process.env.ANDROID_KEYSTORE_PASSWORD = password;
  });
  await assert.rejects(patchAppGradleSigning(root, { keystore }), /non-empty keystore password/);
});

test("existing signing identities are never silently regenerated", async (context) => {
  const { root } = await fixture(context);
  await writeFile(path.join(root, "android.keystore"), "existing key");
  await assert.rejects(patchAppGradleSigning(root, {}), /no properties file/);
  assert.equal(await readFile(path.join(root, "android.keystore"), "utf8"), "existing key");
  const missingKey = await fixture(context);
  await writeFile(path.join(missingKey.root, "android.keystore.properties"), "storePassword=existing-secret\n");
  await assert.rejects(patchAppGradleSigning(missingKey.root, {}), /matching keystore is missing/);
});

function mockCommand(context, handler = () => {}) {
  const calls = [];
  context.mock.method(childProcess, "spawn", (command, args, options) => {
    const child = new EventEmitter();
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    child.kill = () => {
      child.emit("close", 0);
    };
    const call = { command, args, options, child };
    calls.push(call);
    queueMicrotask(() => {
      handler(call);
      child.emit("close", 0);
    });
    return child;
  });
  syncBuiltinESMExports();
  context.after(() => {
    context.mock.restoreAll();
    syncBuiltinESMExports();
  });
  return calls;
}

test("documented Tauri namespace delegates to the named functions", () => {
  assert.equal(Tauri.run, run);
  assert.equal(Tauri.build, build);
});

test("desktop run selects the release binary and preserves spaces in paths", async (context) => {
  const { root } = await fixture(context);
  const directory = path.join(root, "app with spaces");
  const executable = path.join(directory, "target", "release", `example${process.platform === "win32" ? ".exe" : ""}`);
  await mkdir(path.dirname(executable), { recursive: true });
  await writeFile(executable, "binary");
  const calls = mockCommand(context);
  await (await run({ platform: "desktop", buildDir: directory, app: { name: "example" } })).end();
  assert.equal(calls[0].command, executable);
  assert.deepEqual(calls[0].args, []);
  assert.equal(calls[0].options.shell, false);
});

test("Android release deployment uses array arguments and close completes the handle", async (context) => {
  const { root } = await fixture(context);
  const apk = path.join(root, "gen/android/app/build/outputs/apk/universal/release/app-universal-release.apk");
  await mkdir(path.dirname(apk), { recursive: true });
  await writeFile(apk, "apk");
  const calls = mockCommand(context);
  const handle = await run({ platform: "android", buildDir: root, app: { id: "org.example.app" } });
  assert.deepEqual(calls[0].args, ["install", "-r", apk]);
  assert.deepEqual(calls[1].args, ["shell", "am", "start", "-n", "org.example.app/org.example.app.MainActivity"]);
  let closed = false;
  handle.on("close", () => {
    closed = true;
  });
  await handle.close();
  await handle.end();
  assert.equal(closed, true);
  assert.deepEqual(calls[2].args, ["shell", "am", "force-stop", "org.example.app"]);
});

test("Android install failures preserve device diagnostics", async (context) => {
  const { root } = await fixture(context);
  const apk = path.join(root, "gen/android/app/build/outputs/apk/universal/release/app-universal-release.apk");
  await mkdir(path.dirname(apk), { recursive: true });
  await writeFile(apk, "apk");
  mockCommand(context, ({ child }) => {
    child.stderr.write("INSTALL_FAILED_UPDATE_INCOMPATIBLE");
    child.emit("close", 1);
  });
  await assert.rejects(run({ platform: "android", buildDir: root }), /INSTALL_FAILED_UPDATE_INCOMPATIBLE/);
});

test("minimal desktop builds generate every referenced icon and invoke the pinned CLI without a shell", async (context) => {
  const { root } = await fixture(context);
  const calls = mockCommand(context);
  const result = await build({ platform: "desktop", buildDir: root, app: { name: "example", id: "org.example.app" } });
  const config = JSON.parse(await readFile(path.join(root, "tauri.conf.json"), "utf8"));
  assert.doesNotMatch(await readFile(path.join(root, "Cargo.toml"), "utf8"), /"devtools"/);
  for (const icon of config.bundle.icon) assert.ok((await stat(path.join(root, icon))).size > 0);
  assert.equal(result.type, "release");
  assert.equal(
    result.paths.at(-1),
    path.join(root, "target", "release", `example${process.platform === "win32" ? ".exe" : ""}`),
  );
  assert.equal(calls[0].command, process.execPath);
  assert.deepEqual(calls[0].args.slice(1), ["build"]);
  assert.match(calls[0].args[0], /tauri\.js$/);
  assert.equal(calls[0].options.shell, false);
  assert.equal(TAURI_VERSION, "2.12.1");
  await assert.rejects(stat(path.join(root, "plugins")), { code: "ENOENT" });
});

test("generated capabilities omit execution grants and validate explicit scopes", async (context) => {
  const { root } = await fixture(context);
  await mkdir(path.join(root, "capabilities"));
  const file = path.join(root, "capabilities/default.json");
  await writeFile(file, "{}");
  await patchCapabilities(root, { platform: "desktop" });
  const generated = JSON.parse(await readFile(file, "utf8"));
  assert.equal(JSON.stringify(generated).includes("shell:allow-execute"), false);
  assert.equal(JSON.stringify(generated).includes("shell:allow-spawn"), false);
  for (const extraCapabilities of ["shell:allow-execute", [null], [{}], [{ identifier: "fs:scope", allow: {} }]]) {
    await assert.rejects(patchCapabilities(root, { extraCapabilities }), TypeError);
  }
  const warning = context.mock.method(console, "warn", () => {});
  const grant = { identifier: "shell:allow-execute", allow: [{ name: "git", cmd: "git", args: ["--version"] }] };
  await patchCapabilities(root, { platform: "desktop", extraCapabilities: [grant, grant] });
  assert.ok(warning.mock.callCount() > 0);
  const permissions = JSON.parse(await readFile(file, "utf8")).permissions;
  assert.equal(permissions.filter((permission) => permission?.identifier === grant.identifier).length, 1);
});

test("process arguments with spaces and shell metacharacters stay literal", async () => {
  const value = "spaces & pipes | semicolons ; $variables";
  let output = "";
  const command = exec(process.execPath, ["-e", "process.stdout.write(process.argv[1])", value], { stdio: "pipe" });
  command.on("data", (text) => {
    output += text;
  });
  await command.end();
  assert.equal(output, value);
});

test("missing ADB gets a tool-installation error without masking other failures", async (context) => {
  const { root } = await fixture(context);
  const apk = path.join(root, "gen/android/app/build/outputs/apk/universal/release/app-universal-release.apk");
  await mkdir(path.dirname(apk), { recursive: true });
  await writeFile(apk, "apk");
  mockCommand(context, ({ child }) => child.emit("error", Object.assign(new Error("spawn adb ENOENT"), { code: "ENOENT" })));
  await assert.rejects(run({ platform: "android", buildDir: root }), /ADB not found/);
});

test("development launches use debug artifacts and the Android dev identifier", async (context) => {
  const nodeEnv = process.env.NODE_ENV;
  process.env.NODE_ENV = "development";
  context.after(() => {
    if (nodeEnv === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = nodeEnv;
  });
  const { run: runDebug } = await import("../index.js?debug-profile");
  const { root } = await fixture(context);
  const executable = path.join(root, "target/debug", `example${process.platform === "win32" ? ".exe" : ""}`);
  await mkdir(path.dirname(executable), { recursive: true });
  await writeFile(executable, "binary");
  const apk = path.join(root, "gen/android/app/build/outputs/apk/universal/debug/app-universal-debug.apk");
  await mkdir(path.dirname(apk), { recursive: true });
  await writeFile(apk, "apk");
  const calls = mockCommand(context);
  await (await runDebug({ platform: "desktop", buildDir: root, app: { name: "example" } })).end();
  assert.equal(calls[0].command, executable);
  const handle = await runDebug({ platform: "android", buildDir: root, app: { id: "org.example.app" } });
  await handle.close();
  await handle.end();
  assert.deepEqual(calls[1].args, ["install", "-r", apk]);
  assert.deepEqual(calls[2].args, ["shell", "am", "start", "-n", "org.example.app.dev/org.example.app.MainActivity"]);
});
