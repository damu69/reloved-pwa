import sharp, { type Metadata } from "sharp";
import { sniffDocumentType } from "./storage.js";

// Product photos: JPEG, PNG or WebP in, three WebP sizes out. Metadata (including GPS) is stripped
// because sharp does not copy it unless asked. Very large images are refused before decoding.
export const IMAGE_SIZES = [200, 600, 1200] as const;
export type ImageSize = (typeof IMAGE_SIZES)[number];
export const MAX_IMAGE_BYTES = 8 * 1024 * 1024;

export class ImageError extends Error {}

export async function processProductImage(input: Buffer): Promise<{ width: number; height: number; outputs: { size: ImageSize; body: Buffer }[] }> {
  const kind = sniffDocumentType(input);
  if (!kind || kind.mime === "application/pdf") throw new ImageError("Upload a JPEG, PNG or WebP image.");
  let meta: Metadata;
  try {
    meta = await sharp(input, { limitInputPixels: 40_000_000, failOn: "error" }).metadata();
  } catch {
    throw new ImageError("This image could not be read.");
  }
  if (!meta.width || !meta.height) throw new ImageError("This image could not be read.");
  if (Math.min(meta.width, meta.height) < 300) throw new ImageError("Use an image at least 300 pixels on each side.");
  const outputs = [];
  let width = 0, height = 0;
  try {
    for (const size of IMAGE_SIZES) {
      // Only the first frame of an animated image is used (sharp's default).
      const { data, info } = await sharp(input, { limitInputPixels: 40_000_000, failOn: "error" })
        .rotate() // apply the camera's orientation, then drop it with the rest of the metadata
        .resize({ width: size, height: size, fit: "inside", withoutEnlargement: true })
        .webp({ quality: 80 })
        .toBuffer({ resolveWithObject: true });
      outputs.push({ size, body: data });
      if (size === 1200) { width = info.width; height = info.height; }
    }
  } catch {
    // Header looked fine but the image data is broken or truncated.
    throw new ImageError("This image could not be read.");
  }
  return { width, height, outputs };
}
