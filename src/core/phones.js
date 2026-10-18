// Israeli mobile normalization: 05X + 7 digits → '972' + 9 digits.
export function normalizePhone(value) {
  if (value === null || value === undefined) return null;
  let d = String(value).replace(/\D/g, '');
  if (d.startsWith('00')) d = d.slice(2);
  if (d.startsWith('972')) d = d.slice(3);
  else if (d.startsWith('0')) d = d.slice(1);
  return /^5\d{8}$/.test(d) ? `972${d}` : null;
}
