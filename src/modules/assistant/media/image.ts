import { fileTypeFromBuffer } from "file-type";
import { AppError } from "../../../utils/errors.js";

const IMAGE_TYPES = new Set(["image/jpeg", "image/png", "image/webp", "image/gif"]);

export type ValidatedImage = {
  mimeType: string;
  extension: string;
  dataUrl: string;
};

export async function validateImage(buffer: Buffer): Promise<ValidatedImage> {
  const detected = await fileTypeFromBuffer(buffer);

  if (!detected || !IMAGE_TYPES.has(detected.mime)) {
    throw new AppError(415, "Please upload a JPEG, PNG, WebP or GIF image.");
  }

  return {
    mimeType: detected.mime,
    extension: detected.ext,
    dataUrl: `data:${detected.mime};base64,${buffer.toString("base64")}`,
  };
}

export function sanitizeFilename(name: string | undefined, fallback: string): string {
  const cleaned = (name ?? "")
    .replace(/[\\/:*?"<>|\u0000-\u001f]/g, "_")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 120);
  return cleaned || fallback;
}
