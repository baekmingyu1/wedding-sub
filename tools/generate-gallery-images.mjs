import { createHash } from "node:crypto";
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { runInNewContext } from "node:vm";
import sharp from "sharp";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const sourceDir = join(root, "assets", "gallery");
const outputDir = join(sourceDir, "web");
const shareDir = join(root, "assets", "share");
const originals = (await readdir(sourceDir)).filter((name) => /\.jpe?g$/i.test(name)).sort((a, b) => a.localeCompare(b, "en", { numeric: true }));
const sandbox = { window: {} };
const manifestPath = join(root, "gallery-images.js");
if (!originals.length) runInNewContext(await readFile(manifestPath, "utf8"), sandbox);
const previous = sandbox.window.GALLERY_IMAGES || [];
const inputs = originals.length ? originals : previous;
if (!inputs.length) throw new Error("갤러리 원본 또는 기존 이미지 목록이 필요합니다.");
await mkdir(outputDir, { recursive: true });
await mkdir(shareDir, { recursive: true });
const photos = [];
let wideSource;
for (const [index, source] of inputs.entries()) {
  // Without local JPGs, always derive smaller assets from the unchanged 1200px
  // WebP, never from a previous optimization output. Keep the selected photo order.
  const input = await readFile(originals.length ? join(sourceDir, source) : join(root, source.src));
  const metadata = await sharp(input).metadata();
  if (originals.length && (!wideSource || metadata.width >= metadata.height)) wideSource = input;
  const candidates = [];
  for (const [width, quality] of [[320, 72], [640, 76], [960, 78], [1200, 80]]) {
    let path;
    if (!originals.length && (width === 640 || width === 1200)) {
      path = source.srcset.split(", ").find((candidate) => candidate.endsWith(` ${width}w`))?.split(" ")[0];
      if (!path) throw new Error(`사진 ${index + 1}: ${width}px 기준 이미지가 없습니다.`);
    } else {
      const bytes = await sharp(input).rotate().resize({ width, withoutEnlargement: true })
        .webp({ quality, effort: 6 }).toBuffer();
      const hash = createHash("sha256").update(bytes).digest("hex").slice(0, 10);
      const name = `${String(index + 1).padStart(2, "0")}-${width}-${hash}.webp`;
      await writeFile(join(outputDir, name), bytes);
      path = `assets/gallery/web/${name}`;
    }
    candidates.push({ width, path });
  }
  const src = candidates.at(-1).path;
  const dimensions = await sharp(join(root, src)).metadata();
  photos.push({
    src,
    thumbnail: candidates[0].path,
    mobileSrc: candidates[2].path,
    srcset: candidates.map(({ width, path }) => `${path} ${width}w`).join(", "),
    mobileSrcset: candidates.slice(0, 3).map(({ width, path }) => `${path} ${width}w`).join(", "),
    width: dimensions.width,
    height: dimensions.height
  });
  console.log(`Gallery ${index + 1}/${inputs.length}`);
}
await writeFile(manifestPath, `window.GALLERY_IMAGES = ${JSON.stringify(photos, null, 2)};\n`);
if (wideSource) {
  await sharp(wideSource).rotate().resize(1200, 630, { fit: "cover", position: "centre" })
    .jpeg({ quality: 84, mozjpeg: true }).toFile(join(shareDir, "kakao-thumbnail.jpg"));
}

// The opening may use a gallery photo. Keep its preload in sync with content.js.
sandbox.window.GALLERY_IMAGES = photos;
runInNewContext(await readFile(join(root, "opening-images.js"), "utf8"), sandbox);
runInNewContext(await readFile(join(root, "content.js"), "utf8"), sandbox);
const opening = sandbox.window.WEDDING_CONTENT.openingPhotos?.[0];
if (photos.includes(opening)) {
  const htmlPath = join(root, "index.html");
  const html = await readFile(htmlPath, "utf8");
  const marker = /<!-- OPENING_PRELOAD_START -->[\s\S]*?<!-- OPENING_PRELOAD_END -->/;
  if (!marker.test(html)) throw new Error("대표 사진 preload marker가 없습니다.");
  const preload = [
    "<!-- OPENING_PRELOAD_START -->",
    `  <link rel="preload" as="image" media="(max-width: 760px)" href="${opening.mobileSrc}" imagesrcset="${opening.mobileSrcset}" imagesizes="100vw" fetchpriority="high">`,
    `  <link rel="preload" as="image" media="(min-width: 761px)" href="${opening.src}" imagesrcset="${opening.srcset}" imagesizes="100vw" fetchpriority="high">`,
    "  <!-- OPENING_PRELOAD_END -->"
  ].join("\n");
  await writeFile(htmlPath, html.replace(marker, preload));
}
console.log(`Generated ${photos.length} responsive gallery photos (${originals.length ? "JPG originals" : "retained 1200px WebP sources"}).`);
