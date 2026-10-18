// Soldier identity. Cells are matched to one soldier when the names are *almost identical*:
//   * identical after removing spaces/punctuation/markers and collapsing doubled ו/י spelling
//       (אבי-אור כהן = אבי אור כהן, דני לוי* = דני לוי, נוה כהן = נווה כהן)
//   * identical first name, and a last name that is
//       - one letter apart, or two adjacent letters swapped, when ≥4 letters (רון ברקוביץ = רון ברקוביץה, טל ליבוביץ = טל ליפוביץ, דן ימהרן = דן יהמרן)
//       - identical once the vowel letters א/ו/י are ignored (אור זדה = אור זאדה)
// A one-letter difference in the first name is NOT merged (נוי ≠ נוה).
//   * a short form whose words all appear in exactly ONE longer name (כהן = אור כהן, אלון = אלון לוי)
// Not merged (reported as "possibly the same" instead): a short form matching several soldiers
// (דוד vs דוד כהן and דוד לוי). Multi-name cells and (notes) are split earlier by roster.js.
// The source text of every cell is kept; the merged identity is only an added field.
import { levenshtein, matchKey } from './text.js';

const MULTI = /[/\\()]/;

// Words of a name: in-word quotes removed ("ג'קי" → "גקי"), separators (space - / ( ) * etc.) split
// words, doubled ו/י collapsed.
function tokens(name) {
  return matchKey(name)
    .replace(/['"]/g, '')
    .replace(/[^א-ת]+/g, ' ')
    .replace(/וו/g, 'ו')
    .replace(/יי/g, 'י')
    .split(' ')
    .filter(Boolean);
}

function oneAdjacentSwap(a, b) {
  if (a.length !== b.length) return false;
  const diff = [...a].map((ch, i) => i).filter((i) => a[i] !== b[i]);
  return diff.length === 2 && diff[1] === diff[0] + 1 && a[diff[0]] === b[diff[1]] && a[diff[1]] === b[diff[0]];
}

// 'same' | 'related' | null
export function nameRelation(a, b) {
  const ta = tokens(a);
  const tb = tokens(b);
  if (!ta.length || !tb.length) return null;
  let almost = ta.join('') === tb.join('');
  if (!almost && ta.length >= 2 && tb.length >= 2 && ta[0] === tb[0]) {
    const lastA = ta.slice(1).join('');
    const lastB = tb.slice(1).join('');
    const consonants = (w) => w.replace(/[אוי]/g, '');
    almost =
      (Math.min(lastA.length, lastB.length) >= 4 && (levenshtein(lastA, lastB) <= 1 || oneAdjacentSwap(lastA, lastB))) ||
      (consonants(lastA).length >= 2 && consonants(lastA) === consonants(lastB));
  }
  if (almost) return MULTI.test(a) || MULTI.test(b) ? 'related' : 'same';
  const [short, long] = ta.length <= tb.length ? [ta, tb] : [tb, ta];
  if (short.length < long.length && short.every((t) => long.includes(t))) return 'related';
  return null;
}

// Adds `person` (display) and `personKey` to each assignment. Returns { merges, related }.
export function identifySoldiers(assignments) {
  const counts = new Map(); // matchKey → { name, count, order }
  for (const a of assignments) {
    const k = a.soldierKey;
    if (!counts.has(k)) counts.set(k, { name: a.soldier, count: 0, order: counts.size });
    counts.get(k).count++;
  }
  const keys = [...counts.keys()];
  const parent = new Map(keys.map((k) => [k, k]));
  const find = (k) => (parent.get(k) === k ? k : (parent.set(k, find(parent.get(k))), parent.get(k)));
  const related = [];
  for (let i = 0; i < keys.length; i++) {
    for (let j = i + 1; j < keys.length; j++) {
      if (isUnitName(counts.get(keys[i]).name) || isUnitName(counts.get(keys[j]).name)) continue; // units never merge with people
      const rel = nameRelation(counts.get(keys[i]).name, counts.get(keys[j]).name);
      if (rel === 'same') parent.set(find(keys[i]), find(keys[j]));
      else if (rel === 'related') related.push([keys[i], keys[j]]);
    }
  }

  // Short form → full name, only when exactly one distinct soldier contains it.
  const shortKey = (x, y) => (tokens(counts.get(x).name).length < tokens(counts.get(y).name).length ? [x, y] : [y, x]);
  const fullsByShort = new Map();
  for (const [x, y] of related) {
    const [short, full] = shortKey(x, y);
    if (tokens(counts.get(short).name).length === tokens(counts.get(full).name).length) continue;
    if (!fullsByShort.has(short)) fullsByShort.set(short, new Set());
    fullsByShort.get(short).add(full);
  }
  for (const [short, fulls] of fullsByShort) {
    const people = new Set([...fulls].map(find));
    if (people.size === 1) parent.set(find(short), [...people][0]);
  }

  const groups = new Map();
  for (const k of keys) {
    const root = find(k);
    if (!groups.has(root)) groups.set(root, []);
    groups.get(root).push(counts.get(k));
  }
  // Display name: most frequent spelling; ties → longer, then first seen.
  const canonical = new Map();
  const merges = [];
  for (const [root, variants] of groups) {
    variants.sort((x, y) => y.count - x.count || y.name.length - x.name.length || x.order - y.order);
    const name = variants[0].name;
    canonical.set(root, { name, key: matchKey(name) });
    if (variants.length > 1) merges.push({ person: name, variants: variants.map(({ name: n, count }) => ({ name: n, count })) });
  }
  for (const a of assignments) {
    const c = canonical.get(find(a.soldierKey));
    a.person = c.name;
    a.personKey = c.key;
  }

  const seen = new Set();
  const relatedPeople = [];
  for (const [x, y] of related) {
    const px = canonical.get(find(x));
    const py = canonical.get(find(y));
    if (px.key === py.key) continue;
    const pair = [px.key, py.key].sort().join('|');
    if (seen.has(pair)) continue;
    seen.add(pair);
    relatedPeople.push([px.name, py.name]);
  }
  return { merges, related: relatedPeople };
}

// "מחלקה 2", "פלוגה ב", "צוות 3": a unit written in a person cell, not an individual soldier.
// Units cover posts (search, board) but are not soldiers (no soldier entry, no message, no overlap).
export function isUnitName(name) {
  return /^(מחלקה|פלוגה|צוות)(\s|$)/.test(name.trim());
}
