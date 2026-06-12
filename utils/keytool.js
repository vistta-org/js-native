import fs from "@vistta/fs";
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";

/**
 * Ensures an Android keystore exists at `keystorePath` and returns the
 * credentials needed to sign the APK. Zero-config: if the file is missing,
 * a 2048-bit RSA keystore is generated with a random password, and the
 * password is written to a sidecar file next to the keystore so the SAME
 * cert can be reused on subsequent builds (updates install over previous).
 *
 * Resolution order for each input:
 *   - alias:    `alias` arg → `appId` arg → "android"
 *   - dname:    `dname` arg → "CN=<alias>, O=Vistta, C=US"
 *
 * The password is ALWAYS generated randomly on first run and persisted to
 * `<keystoreDir>/.credentials`. Subsequent builds read the password back.
 * There's no API to override the password — that keeps the flow zero-config.
 * Set `config.signing = false` in your setup module to opt out entirely
 * (produces an unsigned APK, like the pre-keystore behaviour).
 *
 * Requires the JDK (`keytool` ships with it). Tauri requires the JDK for
 * Android builds anyway, so `keytool` is always available in the build env.
 *
 * @param {object} args
 * @param {string} args.keystorePath  Absolute path to the .keystore file.
 * @param {string} [args.alias]       Key alias; defaults to args.appId or "android".
 * @param {string} [args.appId]       App ID (used as default alias and dname CN).
 * @param {string} [args.dname]       X.500 name; defaults to "CN=<alias>, O=Vistta, C=US".
 * @returns {Promise<{ keystorePath: string, alias: string, storePassword: string, keyPassword: string, generated: boolean }>}
 */
export async function ensureKeystore({ keystorePath, alias, appId, dname }) {
  const finalAlias = alias || appId || "android";
  const finalDname = dname || `CN=${finalAlias}, O=Vistta, C=US`;

  // Sidecar credentials file: a single JSON object with {storepass, keypass}.
  // Lives next to the keystore so a single relative path covers both.
  const credsPath = fs.resolve(fs.dirname(keystorePath), ".credentials");

  if (fs.existsSync(keystorePath) && fs.existsSync(credsPath)) {
    // Reuse the existing keystore + its saved password.
    const { storepass, keypass } = JSON.parse(String(await fs.readFile(credsPath, "utf8")));
    return { keystorePath, alias: finalAlias, storePassword: storepass, keyPassword: keypass, generated: false };
  }

  // First run: generate a random password, create the keystore, persist the
  // password so the next build can reuse the same cert.
  const password = randomBytes(24).toString("base64url");
  await fs.mkdir(fs.dirname(keystorePath), { recursive: true });

  await runKeytool([
    "-genkeypair",
    "-keystore",
    keystorePath,
    "-alias",
    finalAlias,
    "-storepass",
    password,
    "-keypass",
    password,
    "-dname",
    finalDname,
    "-keyalg",
    "RSA",
    "-keysize",
    "2048",
    "-validity",
    "10000",
    "-v",
  ]);

  await fs.writeFile(credsPath, JSON.stringify({ storepass: password, keypass: password }, null, 2));

  return { keystorePath, alias: finalAlias, storePassword: password, keyPassword: password, generated: true };
}

function runKeytool(args) {
  return new Promise((resolve, reject) => {
    const proc = spawn("keytool", args, { stdio: "inherit" });
    proc.on("error", (err) =>
      reject(
        new Error(`Failed to spawn keytool: ${err.message}. Ensure the JDK is installed and 'keytool' is in your PATH.`),
      ),
    );
    proc.on("close", (code) => (code === 0 ? resolve() : reject(new Error(`keytool exited with code ${code}`))));
  });
}
