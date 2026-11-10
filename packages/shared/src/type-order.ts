export const TYPE_ORDER = [
  "xlsx",
  "docx",
  "pdf",
  "pptx",
  "images",
  "videos",
  "other",
] as const;

export type QueueType = (typeof TYPE_ORDER)[number];

const IMAGE_EXT = new Set([
  "jpg",
  "jpeg",
  "png",
  "gif",
  "webp",
  "heic",
  "tif",
  "tiff",
  "bmp",
]);

const VIDEO_EXT = new Set([
  "mp4",
  "mov",
  "m4v",
  "avi",
  "mkv",
  "webm",
  "wmv",
]);

export function extToQueueType(ext: string): QueueType {
  const e = ext.replace(/^\./, "").toLowerCase();
  if (e === "xlsx" || e === "xls") return "xlsx";
  if (e === "docx" || e === "doc") return "docx";
  if (e === "pdf") return "pdf";
  if (e === "pptx" || e === "ppt") return "pptx";
  if (IMAGE_EXT.has(e)) return "images";
  if (VIDEO_EXT.has(e)) return "videos";
  return "other";
}
