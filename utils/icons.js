import fs from "@vistta/fs";
import sharp from "sharp";

/**
 * @typedef {Object} PlatformIconConfig
 * @property {string} target - Target platform ("desktop", "android", "ios")
 * @property {string} buildDir - Build output directory
 * @property {string} sourceIcon - Path to the source icon file
 */

/**
 * Generate app icons from a single source image.
 * @param {PlatformIconConfig} config - Configuration object
 */
export async function generateIcons({ target, buildDir, sourceIcon }) {
  const icon = sharp(sourceIcon);
  const metadata = await icon.metadata();
  const size = Math.max(metadata.width || 512, metadata.height || 512);

  // Ensure minimum size for quality scaling
  const source = size < 512 ? await icon.resize(512, 512, { fit: "contain" }).toBuffer() : await icon.toBuffer();

  await fs.mkdir(fs.resolve(buildDir, "icons"), { recursive: true });

  switch (target) {
    case "android":
      return await generateAndroidIcons(source, buildDir);
    case "desktop":
      return await generateDesktopIcons(source, buildDir);
    case "ios":
      return await generateIOSIcons(source, buildDir);
    default:
      throw new Error(`Unsupported platform "${target}" for icon generation.`);
  }
}

/**
 * Generate Android mipmap and adaptive icon files.
 * @param {Buffer} source - Source image buffer
 * @param {string} buildDir - Build output directory
 */
async function generateAndroidIcons(source, buildDir) {
  const resDir = fs.resolve(buildDir, "gen", "android", "app", "src", "main", "res");

  // Also create the icons/ folder for Tauri (needed for cargo build)
  const iconsDir = fs.resolve(buildDir, "icons");
  await fs.mkdir(iconsDir, { recursive: true });
  await sharp(source).resize(32, 32).png().toFile(fs.resolve(iconsDir, "32x32.png"));
  await sharp(source).resize(128, 128).png().toFile(fs.resolve(iconsDir, "128x128.png"));
  await sharp(source).resize(256, 256).png().toFile(fs.resolve(iconsDir, "128x128@2x.png"));

  // Android mipmap densities
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
    await sharp(source).resize(px, px).png().toFile(fs.resolve(dir, "ic_launcher.png"));
  }
}

/**
 * Generate desktop icons (PNG, ICO, ICNS).
 * @param {Buffer} source - Source image buffer
 * @param {string} buildDir - Build output directory
 */
async function generateDesktopIcons(source, buildDir) {
  const iconsDir = fs.resolve(buildDir, "icons");
  // Standard desktop icons
  await sharp(source).resize(32, 32).png().toFile(fs.resolve(iconsDir, "32x32.png"));
  await sharp(source).resize(128, 128).png().toFile(fs.resolve(iconsDir, "128x128.png"));
  await sharp(source).resize(256, 256).png().toFile(fs.resolve(iconsDir, "128x128@2x.png"));

  // Generate ICO (Windows) - multiple sizes embedded
  const icoSizes = [16, 32, 48, 256];
  const icoBuffers = await Promise.all(icoSizes.map((s) => sharp(source).resize(s, s).png().toBuffer()));
  const icoBuffer = await createIco(icoBuffers, icoSizes);
  await fs.writeFile(fs.resolve(iconsDir, "icon.ico"), icoBuffer);

  // ICNS (macOS)
  const icns128 = await sharp(source).resize(128, 128).png().toBuffer();
  const icns256 = await sharp(source).resize(256, 256).png().toBuffer();
  const icnsBuffer = await createIcns(icns128, icns256);
  await fs.writeFile(fs.resolve(iconsDir, "icon.icns"), icnsBuffer);
}

/**
 * Generate iOS app icons.
 * @param {Buffer} source - Source image buffer
 * @param {string} buildDir - Build output directory
 */
async function generateIOSIcons(source, buildDir) {
  const iconsDir = fs.resolve(buildDir, "icons");
  const iosSizes = [20, 29, 40, 58, 60, 76, 80, 87, 120, 152, 167, 180, 1024];

  for (const size of iosSizes) {
    await sharp(source)
      .resize(size, size)
      .png()
      .toFile(fs.resolve(iconsDir, `${size}x${size}.png`));
  }
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
