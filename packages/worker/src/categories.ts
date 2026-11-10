/** Folder naming helpers: short topic roots, reuse related keywords. */

const STOP = new Set([
  "a",
  "an",
  "the",
  "and",
  "or",
  "of",
  "for",
  "to",
  "in",
  "on",
  "by",
  "with",
  "from",
  "misc",
  "other",
  "general",
  "file",
  "files",
  "document",
  "documents",
]);

/** Fix CamelCase glue and illegal path chars; Title Case words. */
export function normalizeFolderName(raw: string): string {
  let s = raw
    .replace(/[<>:"/\\|?*\u0000-\u001f]/g, " ")
    .replace(/[_-]+/g, " ")
    // Content MigrationWebsite → Content Migration Website
    .replace(/([a-z])([A-Z])/g, "$1 $2")
    // StatisticsVoter → Statistics Voter (also after digits)
    .replace(/([A-Za-z])(\d)/g, "$1 $2")
    .replace(/(\d)([A-Za-z])/g, "$1 $2")
    .replace(/\s+/g, " ")
    .trim();

  if (!s) return "Misc";

  s = s
    .split(" ")
    .filter(Boolean)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase())
    .join(" ");

  return s.slice(0, 60);
}

export function topLevelFromRelpath(relpath: string): string {
  const first = relpath.replace(/\\/g, "/").split("/").filter(Boolean)[0];
  return normalizeFolderName(first ?? "Misc");
}

function tokens(s: string): string[] {
  return normalizeFolderName(s)
    .toLowerCase()
    .split(" ")
    .filter((t) => t.length > 1 && !STOP.has(t));
}

function shareKeyword(a: string, b: string): string | null {
  const ta = tokens(a);
  const tb = new Set(tokens(b));
  for (const t of ta) {
    if (tb.has(t)) return t.charAt(0).toUpperCase() + t.slice(1);
  }
  return null;
}

/**
 * Pick a short reusable root folder. Prefer an existing top-level when related.
 * Put the longer detail into subcategory.
 */
export function polishPlacement(
  categoryRaw: string,
  subcategoryRaw: string | undefined,
  existingTopLevels: string[],
): { category: string; subcategory?: string } {
  const existing = [
    ...new Set(existingTopLevels.map(normalizeFolderName).filter(Boolean)),
  ];

  let category = normalizeFolderName(categoryRaw);
  let subcategory = subcategoryRaw
    ? normalizeFolderName(subcategoryRaw)
    : undefined;

  // If model glued subcategory onto category (no slash), peel it when an
  // existing folder is a prefix of the proposed name.
  for (const ex of existing) {
    const lower = category.toLowerCase();
    const exLower = ex.toLowerCase();
    if (lower !== exLower && lower.startsWith(exLower)) {
      const rest = category.slice(ex.length).trim();
      category = ex;
      subcategory = rest
        ? normalizeFolderName(
            subcategory ? `${rest} ${subcategory}` : rest,
          )
        : subcategory;
      break;
    }
  }

  // Exact / case-insensitive reuse
  const exact = existing.find(
    (e) => e.toLowerCase() === category.toLowerCase(),
  );
  if (exact) {
    category = exact;
  } else {
    // Shared keyword with an existing root → reuse that root
    let best: { name: string; score: number } | null = null;
    for (const ex of existing) {
      const shared = shareKeyword(category, ex);
      if (!shared) continue;
      // Prefer shorter existing roots, and stronger overlap
      const catTok = tokens(category);
      const exTok = tokens(ex);
      const overlap = catTok.filter((t) => exTok.includes(t)).length;
      const score = overlap * 10 - exTok.length;
      if (!best || score > best.score) best = { name: ex, score };
    }
    if (best && best.score >= 9) {
      // Keep leftover words as subcategory when we collapse to a broader root
      const leftover = tokens(category).filter(
        (t) => !tokens(best!.name).includes(t),
      );
      if (leftover.length) {
        const extra = leftover
          .map((t) => t.charAt(0).toUpperCase() + t.slice(1))
          .join(" ");
        subcategory = subcategory
          ? normalizeFolderName(`${extra} ${subcategory}`)
          : normalizeFolderName(extra);
      }
      category = best.name;
    }
  }

  // Force short roots: max 2 meaningful words at top level
  const catTokens = tokens(category);
  if (catTokens.length > 2) {
    const short = catTokens
      .slice(0, 2)
      .map((t) => t.charAt(0).toUpperCase() + t.slice(1))
      .join(" ");
    const rest = catTokens
      .slice(2)
      .map((t) => t.charAt(0).toUpperCase() + t.slice(1))
      .join(" ");
    // Prefer matching an existing 1-word keyword folder
    const oneWord = existing.find(
      (e) => tokens(e).length === 1 && tokens(e)[0] === catTokens[0],
    );
    if (oneWord) {
      const extra = catTokens
        .slice(1)
        .map((t) => t.charAt(0).toUpperCase() + t.slice(1))
        .join(" ");
      subcategory = subcategory
        ? normalizeFolderName(`${extra} ${subcategory}`)
        : normalizeFolderName(extra);
      category = oneWord;
    } else {
      subcategory = subcategory
        ? normalizeFolderName(`${rest} ${subcategory}`)
        : normalizeFolderName(rest);
      category = normalizeFolderName(short);
    }
  }

  // Don't duplicate category inside subcategory
  if (
    subcategory &&
    subcategory.toLowerCase().startsWith(category.toLowerCase())
  ) {
    subcategory = normalizeFolderName(subcategory.slice(category.length));
  }
  if (subcategory && subcategory.toLowerCase() === category.toLowerCase()) {
    subcategory = undefined;
  }
  if (!subcategory) subcategory = undefined;

  return { category, subcategory };
}

export function listTopLevelCategories(relpaths: string[]): string[] {
  return [
    ...new Set(relpaths.map(topLevelFromRelpath).filter((s) => s && s !== "Misc")),
  ].sort((a, b) => a.localeCompare(b));
}
