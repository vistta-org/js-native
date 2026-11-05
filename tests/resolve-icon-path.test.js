import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { resolveIconPath } from "../utils/resolve-icon-path.js";

test("resolves bundled and filesystem icons without silently skipping missing files", (t) => {
  const root = mkdtempSync(path.join(tmpdir(), "vistta-icon-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const buildDir = path.join(root, "build");
  const bundledIcon = path.join(buildDir, "www", "assets", "icon.png");
  mkdirSync(path.dirname(bundledIcon), { recursive: true });
  writeFileSync(bundledIcon, "bundled icon");
  const absoluteIcon = path.join(root, "source.png");
  writeFileSync(absoluteIcon, "source icon");

  assert.equal(resolveIconPath({ buildDir, icon: "/assets/icon.png" }), bundledIcon);
  assert.equal(resolveIconPath({ buildDir, icon: "assets/icon.png" }), bundledIcon);
  assert.equal(resolveIconPath({ buildDir, icon: absoluteIcon }), absoluteIcon);
  assert.equal(resolveIconPath({ buildDir }), null);
  assert.equal(resolveIconPath({ icon: "/assets/icon.png" }), null);
  assert.equal(resolveIconPath(), null);
  assert.throws(() => resolveIconPath({ buildDir, icon: "/assets/missing.png" }), /Icon .* not found/);
  assert.throws(() => resolveIconPath({ buildDir, icon: "missing.png" }), /Icon .* not found/);
  assert.throws(() => resolveIconPath({ buildDir, icon: path.join(root, "missing.png") }), /Icon .* not found/);
});
