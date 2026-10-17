// Text handling for values read from the workbook.
//
// Two explicit levels, nothing else:
//   cleanText(v)  -> display value: source text with leading/trailing whitespace removed and
//                    internal whitespace runs collapsed to one space (NFC). Nothing else changes.
//   matchKey(s)   -> comparison key: cleanText + typographic equivalents unified
//                    (״→"  ׳→'  en/em dash → -). Used only to decide whether two cells hold the
//                    *same* label. Display always uses the source text.
// Distinct labels (e.g. ש"ג vs שער) are never merged.

export function cellToString(value) {
  if (value === null || value === undefined) return '';
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  if (value instanceof Date) return value.toISOString();
  if (Array.isArray(value.richText)) return value.richText.map((r) => r.text).join('');
  if ('result' in value) return cellToString(value.result);
  if ('text' in value) return cellToString(value.text);
  return '';
}

export function cleanText(value) {
  return cellToString(value).normalize('NFC').replace(/\s+/g, ' ').trim();
}

export function matchKey(value) {
  return cleanText(value)
    .replace(/״/g, '"')
    .replace(/׳/g, "'")
    .replace(/[–—‒‑]/g, '-');
}

// Header keywords are structural, not business data: they tell the parser which
// column holds the day / hours / task. Spaces are ignored so "מתאריך – עד" matches.
export function headerKey(value) {
  return matchKey(value).replace(/\s+/g, '');
}

// Characters suggesting a cell holds more than a plain name (alternates, notes, markers).
export function hasNameAnnotation(name) {
  return /[/\\()*\d+?!,;]/.test(name);
}

export function levenshtein(a, b) {
  if (a === b) return 0;
  const prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    let diag = prev[0];
    prev[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const tmp = prev[j];
      prev[j] = Math.min(prev[j] + 1, prev[j - 1] + 1, diag + (a[i - 1] === b[j - 1] ? 0 : 1));
      diag = tmp;
    }
  }
  return prev[b.length];
}
