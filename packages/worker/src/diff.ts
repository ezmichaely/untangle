/** Line-oriented mismatch list between two extracted text blobs. */
export function textMismatches(a: string, b: string, max = 40): string[] {
  const la = a.split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
  const lb = b.split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
  const out: string[] = [];
  const n = Math.max(la.length, lb.length);
  for (let i = 0; i < n && out.length < max; i++) {
    const left = la[i] ?? "";
    const right = lb[i] ?? "";
    if (left !== right) {
      out.push(`L${i + 1}: ${JSON.stringify(left)} ≠ ${JSON.stringify(right)}`);
    }
  }
  return out;
}

export function summaryMismatches(
  a: Record<string, unknown>,
  b: Record<string, unknown>,
): string[] {
  const ta =
    typeof a.text === "string"
      ? a.text
      : typeof a.sample === "string"
        ? a.sample
        : JSON.stringify(a);
  const tb =
    typeof b.text === "string"
      ? b.text
      : typeof b.sample === "string"
        ? b.sample
        : JSON.stringify(b);

  if (ta === tb) return [];

  // Word-level for short docs
  if (ta.length < 4_000 && tb.length < 4_000) {
    const wa = ta.split(/\s+/);
    const wb = tb.split(/\s+/);
    const mismatches: string[] = [];
    const n = Math.max(wa.length, wb.length);
    for (let i = 0; i < n && mismatches.length < 40; i++) {
      if ((wa[i] ?? "") !== (wb[i] ?? "")) {
        mismatches.push(
          `W${i + 1}: ${JSON.stringify(wa[i] ?? "")} ≠ ${JSON.stringify(wb[i] ?? "")}`,
        );
      }
    }
    if (mismatches.length) return mismatches;
  }
  return textMismatches(ta, tb);
}
