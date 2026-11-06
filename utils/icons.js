import fs from "@vistta/fs";
import { writeIfChanged } from "./write-if-changed.js";

// Lazy-load sharp so it's only required when icon generation is actually
// needed. sharp is a heavy native module (platform-specific binaries); apps
// that don't customise icons never pay the import cost.
let _sharp;
async function loadSharp() {
  if (!_sharp) _sharp = (await import("sharp")).default;
  return _sharp;
}

/**
 * @typedef {Object} PlatformIconConfig
 * @property {string} target - Target platform ("desktop", "android", "ios")
 * @property {string} buildDir - Build output directory
 * @property {string|null} [sourceIcon] - Path to a source icon; omitted for the built-in neutral icon.
 */

/**
 * Generate app icons from a single source image.
 * @param {PlatformIconConfig} config - Configuration object
 */
export async function generateIcons({ target, buildDir, sourceIcon }) {
  const sharp = await loadSharp();
  const icon = sourceIcon
    ? sharp(sourceIcon)
    : sharp({ create: { width: 512, height: 512, channels: 4, background: "#3b3b40" } });
  const metadata = await icon.metadata();
  const size = Math.max(metadata.width || 512, metadata.height || 512);

  // Ensure minimum size for quality scaling
  const source = size < 512 ? await icon.resize(512, 512, { fit: "contain" }).png().toBuffer() : await icon.png().toBuffer();

  await fs.mkdir(fs.resolve(buildDir, "icons"), { recursive: true });

  switch (target) {
    case "android":
      return await generateAndroidIcons(sharp, source, buildDir);
    case "desktop":
      return await generateDesktopIcons(sharp, source, buildDir);
    case "ios":
      return await generateIOSIcons(sharp, source, buildDir);
    default:
      throw new Error(`Unsupported platform "${target}" for icon generation.`);
  }
}

/**
 * Generate Android mipmap and adaptive icon files.
 * @param {Buffer} source - Source image buffer
 * @param {string} buildDir - Build output directory
 */
async function generateAndroidIcons(sharp, source, buildDir) {
  const resDir = fs.resolve(buildDir, "gen", "android", "app", "src", "main", "res");

  // icons/ folder for Tauri (referenced by Cargo bundle config and the
  // notification plugin's iconPath).
  const iconsDir = fs.resolve(buildDir, "icons");
  await fs.mkdir(iconsDir, { recursive: true });
  await writeImage(sharp(source).resize(32, 32).png(), fs.resolve(iconsDir, "32x32.png"));
  await writeImage(sharp(source).resize(128, 128).png(), fs.resolve(iconsDir, "128x128.png"));
  await writeImage(sharp(source).resize(256, 256).png(), fs.resolve(iconsDir, "128x128@2x.png"));
  await writeNotificationIcon(sharp, source, iconsDir);

  // Legacy launcher (pre-Android 8) — full square bitmap.
  const densities = [
    { name: "mipmap-mdpi", size: 48 },
    { name: "mipmap-hdpi", size: 72 },
    { name: "mipmap-xhdpi", size: 96 },
    { name: "mipmap-xxhdpi", size: 144 },
    { name: "mipmap-xxxhdpi", size: 192 },
  ];
  for (const { name, size: px } of densities) {
    const dir = fs.resolve(resDir, name);
    await fs.mkdir(dir, { recursive: true });
    await writeImage(sharp(source).resize(px, px).png(), fs.resolve(dir, "ic_launcher.png"));
    await writeImage(sharp(source).resize(px, px).png(), fs.resolve(dir, "ic_launcher_round.png"));
  }

  // Adaptive launcher (Android 8+) — foreground bitmap is 108dp, the inner 72dp
  // is the safe zone (the launcher applies a mask + shadow + offset). We draw
  // the source within the safe area centred on a transparent canvas.
  const fgDensities = [
    { name: "mipmap-mdpi", outer: 108, safe: 72 },
    { name: "mipmap-hdpi", outer: 162, safe: 108 },
    { name: "mipmap-xhdpi", outer: 216, safe: 144 },
    { name: "mipmap-xxhdpi", outer: 324, safe: 216 },
    { name: "mipmap-xxxhdpi", outer: 432, safe: 288 },
  ];
  for (const { name, outer, safe } of fgDensities) {
    const dir = fs.resolve(resDir, name);
    await fs.mkdir(dir, { recursive: true });
    const inner = await sharp(source)
      .resize(safe, safe, { fit: "contain", background: { r: 0, g: 0, b: 0, alpha: 0 } })
      .ensureAlpha()
      .png()
      .toBuffer();
    const padded = await sharp({
      create: { width: outer, height: outer, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } },
    })
      .composite([{ input: inner, top: Math.floor((outer - safe) / 2), left: Math.floor((outer - safe) / 2) }])
      .png()
      .toBuffer();
    await writeIfChanged(fs.resolve(dir, "ic_launcher_foreground.png"), padded);
  }

  // Adaptive icon XML + background colour resource.
  const anyDpiDir = fs.resolve(resDir, "mipmap-anydpi-v26");
  await fs.mkdir(anyDpiDir, { recursive: true });
  const adaptiveXml = `<?xml version="1.0" encoding="utf-8"?>
<adaptive-icon xmlns:android="http://schemas.android.com/apk/res/android">
    <background android:drawable="@color/ic_launcher_background" />
    <foreground android:drawable="@mipmap/ic_launcher_foreground" />
</adaptive-icon>
`;
  await writeIfChanged(fs.resolve(anyDpiDir, "ic_launcher.xml"), adaptiveXml);
  await writeIfChanged(fs.resolve(anyDpiDir, "ic_launcher_round.xml"), adaptiveXml);

  const valuesDir = fs.resolve(resDir, "values");
  await fs.mkdir(valuesDir, { recursive: true });
  const colorsPath = fs.resolve(valuesDir, "ic_launcher_background.xml");
  const colorsXml = `<?xml version="1.0" encoding="utf-8"?>
<resources>
    <color name="ic_launcher_background">#FFFFFF</color>
</resources>
`;
  await writeIfChanged(colorsPath, colorsXml);

  // Notification status-bar icons (monochrome silhouette per Android design guidelines).
  // The plugin and the foreground service both reference R.drawable.ic_stat_notification.
  const statDensities = [
    { name: "drawable-mdpi", size: 24 },
    { name: "drawable-hdpi", size: 36 },
    { name: "drawable-xhdpi", size: 48 },
    { name: "drawable-xxhdpi", size: 72 },
    { name: "drawable-xxxhdpi", size: 96 },
  ];
  for (const { name, size: px } of statDensities) {
    const dir = fs.resolve(resDir, name);
    await fs.mkdir(dir, { recursive: true });
    await writeImage(silhouette(sharp, source, px), fs.resolve(dir, "ic_stat_notification.png"));
  }
}

/**
 * Generate desktop icons (PNG, ICO, ICNS).
 * @param {Buffer} source - Source image buffer
 * @param {string} buildDir - Build output directory
 */
async function generateDesktopIcons(sharp, source, buildDir) {
  const iconsDir = fs.resolve(buildDir, "icons");
  // Standard desktop icons
  await writeImage(sharp(source).resize(32, 32).png(), fs.resolve(iconsDir, "32x32.png"));
  await writeImage(sharp(source).resize(128, 128).png(), fs.resolve(iconsDir, "128x128.png"));
  await writeImage(sharp(source).resize(256, 256).png(), fs.resolve(iconsDir, "128x128@2x.png"));
  await writeNotificationIcon(sharp, source, iconsDir);

  // Generate ICO (Windows) - multiple sizes embedded
  const icoSizes = [16, 32, 48, 256];
  const icoBuffers = await Promise.all(icoSizes.map((s) => sharp(source).resize(s, s).png().toBuffer()));
  const icoBuffer = await createIco(icoBuffers, icoSizes);
  await writeIfChanged(fs.resolve(iconsDir, "icon.ico"), icoBuffer);

  // ICNS (macOS)
  const icns128 = await sharp(source).resize(128, 128).png().toBuffer();
  const icns256 = await sharp(source).resize(256, 256).png().toBuffer();
  const icnsBuffer = await createIcns(icns128, icns256);
  await writeIfChanged(fs.resolve(iconsDir, "icon.icns"), icnsBuffer);
}

/**
 * Generate iOS app icons.
 * @param {Buffer} source - Source image buffer
 * @param {string} buildDir - Build output directory
 */
async function generateIOSIcons(sharp, source, buildDir) {
  const iconsDir = fs.resolve(buildDir, "icons");
  const iosSizes = [20, 29, 40, 58, 60, 76, 80, 87, 120, 152, 167, 180, 1024];

  for (const size of iosSizes) {
    await writeImage(sharp(source).resize(size, size).png(), fs.resolve(iconsDir, `${size}x${size}.png`));
  }
  await writeNotificationIcon(sharp, source, iconsDir);
}

/** Buffers a sharp pipeline and writes only when the output differs from disk. */
async function writeImage(pipeline, path) {
  const buf = await pipeline.toBuffer();
  await writeIfChanged(path, buf);
}

/**
 * Writes the cross-platform notification icon used by tauri.conf.json
 * `plugins.notification.iconPath`. Kept full-colour for desktop; on Android
 * the silhouette `ic_stat_notification` in res/drawable-* takes precedence.
 * @param {Buffer} source
 * @param {string} iconsDir
 */
async function writeNotificationIcon(sharp, source, iconsDir) {
  await writeImage(sharp(source).resize(96, 96).png(), fs.resolve(iconsDir, "notification.png"));
}

/**
 * Produces a white silhouette of the source on a transparent background, at the
 * requested square size. Pixels with alpha > 0 become white; alpha is preserved.
 * Required for Android status-bar icons (Android 5+ ignores colour).
 * @param {Buffer} source
 * @param {number} size
 */
function silhouette(sharp, source, size) {
  return (
    sharp(source)
      .resize(size, size, { fit: "contain", background: { r: 0, g: 0, b: 0, alpha: 0 } })
      .ensureAlpha()
      // Recolour all opaque pixels to white while preserving alpha.
      .composite([
        {
          input: {
            create: { width: size, height: size, channels: 4, background: { r: 255, g: 255, b: 255, alpha: 1 } },
          },
          blend: "in",
        },
      ])
      .png()
  );
}

/**
 * Create a simple ICO file from PNG buffers.
 * @param {Buffer[]} buffers - PNG buffers for each size
 * @param {number[]} sizes - Corresponding sizes
 */
async function createIco(buffers, sizes) {
  const numImages = buffers.length;
  const headerSize = 6;
  const dirEntrySize = 16;
  const dirSize = dirEntrySize * numImages;

  let dataOffset = headerSize + dirSize;
  const entries = [];
  const imageData = [];

  for (let i = 0; i < numImages; i++) {
    const size = sizes[i];
    const pngData = buffers[i];
    entries.push({
      width: size >= 256 ? 0 : size,
      height: size >= 256 ? 0 : size,
      colorCount: 0,
      reserved: 0,
      planes: 1,
      bitCount: 32,
      bytesInRes: pngData.length,
      imageOffset: dataOffset,
    });
    imageData.push(pngData);
    dataOffset += pngData.length;
  }

  const totalSize = dataOffset;
  const ico = Buffer.alloc(totalSize);

  // Header
  ico.writeUInt16LE(0, 0);
  ico.writeUInt16LE(1, 2);
  ico.writeUInt16LE(numImages, 4);

  // Directory entries
  let offset = headerSize;
  for (const entry of entries) {
    ico.writeUInt8(entry.width, offset);
    ico.writeUInt8(entry.height, offset + 1);
    ico.writeUInt8(entry.colorCount, offset + 2);
    ico.writeUInt8(entry.reserved, offset + 3);
    ico.writeUInt16LE(entry.planes, offset + 4);
    ico.writeUInt16LE(entry.bitCount, offset + 6);
    ico.writeUInt32LE(entry.bytesInRes, offset + 8);
    ico.writeUInt32LE(entry.imageOffset, offset + 12);
    offset += dirEntrySize;
  }

  // Image data
  for (const data of imageData) {
    data.copy(ico, offset);
    offset += data.length;
  }

  return ico;
}

/**
 * Create a simple ICNS file from PNG buffers.
 * @param {Buffer} png128 - 128x128 PNG buffer
 * @param {Buffer} png256 - 256x256 PNG buffer
 */
async function createIcns(png128, png256) {
  const ICON_128 = "ic07";
  const ICON_256 = "ic08";

  function makeChunk(type, data) {
    const size = 8 + data.length;
    const chunk = Buffer.alloc(size);
    chunk.write(type, 0, 4, "ascii");
    chunk.writeUInt32BE(size, 4);
    data.copy(chunk, 8);
    return chunk;
  }

  const chunks = Buffer.concat([makeChunk(ICON_128, png128), makeChunk(ICON_256, png256)]);

  const fileSize = 8 + chunks.length;
  const header = Buffer.alloc(8);
  header.write("icns", 0, 4, "ascii");
  header.writeUInt32BE(fileSize, 4);

  return Buffer.concat([header, chunks]);
}
