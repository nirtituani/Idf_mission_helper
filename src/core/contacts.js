// Contacts Excel (name + phone) parsing and soldier ↔ contact matching.
import { readWorkbook } from './workbook.js';
import { normalizePhone } from './phones.js';
import { nameRelation } from './people.js';

function findHeader(sheet) {
  const byRow = new Map();
  for (const cell of sheet.cells.values()) {
    if (!byRow.has(cell.r)) byRow.set(cell.r, []);
    byRow.get(cell.r).push(cell);
  }
  for (const r of [...byRow.keys()].sort((a, b) => a - b)) {
    const cells = byRow.get(r);
    const name = cells.find((x) => x.text.trim() === 'שם');
    const phone = cells.find((x) => x.text.trim() === 'טלפון');
    if (name && phone) return { r, nameCol: name.c, phoneCol: phone.c };
  }
  return null;
}

export async function parseContactsWorkbook(buffer) {
  const sheets = await readWorkbook(buffer);
  for (const sheet of sheets) {
    if (sheet.hidden) continue;
    const header = findHeader(sheet);
    if (!header) continue;
    const maxRow = Math.max(...[...sheet.cells.values()].map((x) => x.r));
    const errors = [];
    const rows = [];
    for (let r = header.r + 1; r <= maxRow; r++) {
      const name = (sheet.cells.get(`${r}:${header.nameCol}`)?.text ?? '').trim();
      const rawPhone = (sheet.cells.get(`${r}:${header.phoneCol}`)?.text ?? '').trim();
      if (!name && !rawPhone) continue;
      if (!rawPhone) continue;
      const phone = normalizePhone(rawPhone);
      if (!phone) {
        errors.push({ row: r, message: `שורה ${r}: מספר טלפון לא תקין` });
        continue;
      }
      if (!name) {
        errors.push({ row: r, message: `שורה ${r}: חסר שם` });
        continue;
      }
      rows.push({ row: r, name, phone });
    }
    // Duplicate names: report each later occurrence, drop all of the group.
    const dropped = new Set();
    for (let i = 0; i < rows.length; i++) {
      for (let j = i + 1; j < rows.length; j++) {
        if (nameRelation(rows[i].name, rows[j].name) === 'same') {
          dropped.add(i);
          dropped.add(j);
          if (!errors.some((e) => e.row === rows[j].row)) {
            errors.push({ row: rows[j].row, message: `שורה ${rows[j].row}: השם מופיע פעמיים` });
          }
        }
      }
    }
    errors.sort((a, b) => a.row - b.row);
    const contacts = rows.filter((_, i) => !dropped.has(i)).map(({ name, phone }) => ({ name, phone }));
    return { contacts, errors };
  }
  return { contacts: [], errors: [{ row: 0, message: 'לא נמצאה כותרת עם העמודות שם וטלפון' }] };
}

export function matchContacts(soldiers, contacts) {
  const result = new Map();
  for (const s of soldiers) {
    const names = [s.name, ...(s.spellings ?? [])];
    const hits = contacts.filter((c) => names.some((n) => nameRelation(n, c.name) === 'same'));
    result.set(
      s.key,
      hits.length === 1 ? { status: 'ok', phone: hits[0].phone } : hits.length > 1 ? { status: 'ambiguous' } : { status: 'none' },
    );
  }
  // one contact that is the only hit of several soldiers can't be told apart → all of them ambiguous
  const users = new Map();
  for (const [key, m] of result) if (m.status === 'ok') users.set(m.phone, [...(users.get(m.phone) ?? []), key]);
  for (const keys of users.values()) if (keys.length > 1) for (const k of keys) result.set(k, { status: 'ambiguous' });
  return result;
}
