/** Split a path into dirname / basename / ext without Node APIs (UI-safe). */
function splitPath(desired: string): {
  dir: string;
  stem: string;
  ext: string;
  sep: string;
} {
  const sep = desired.includes("\\") && !desired.includes("/") ? "\\" : "/";
  const normalized = desired.replace(/\\/g, "/");
  const idx = normalized.lastIndexOf("/");
  const dir = idx >= 0 ? desired.slice(0, idx) : "";
  const base = idx >= 0 ? desired.slice(idx + 1) : desired;
  const dot = base.lastIndexOf(".");
  const hasExt = dot > 0;
  const ext = hasExt ? base.slice(dot) : "";
  const stem = hasExt ? base.slice(0, dot) : base;
  return { dir, stem, ext, sep: dir.includes("\\") ? "\\" : sep };
}

/** Return desired path, or `name (n).ext` if taken. `exists` is sync. */
export function uniqueDestPath(
  desired: string,
  exists: (absolutePath: string) => boolean,
): string {
  if (!exists(desired)) return desired;

  const { dir, stem, ext, sep } = splitPath(desired);
  let n = 2;
  for (;;) {
    const candidate = dir
      ? `${dir}${sep}${stem} (${n})${ext}`
      : `${stem} (${n})${ext}`;
    if (!exists(candidate)) return candidate;
    n += 1;
  }
}
