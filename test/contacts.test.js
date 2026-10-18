import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizePhone } from '../src/core/phones.js';
import { parseContactsWorkbook, matchContacts } from '../src/core/contacts.js';
import { buildContactsFixture } from './fixtures/build.js';

test('normalizePhone accepts Israeli mobile formats', () => {
  for (const v of ['050-0000001', '0500000001', '+972 50 000 0001', '972500000001', 500000001, '050 000 0001 ']) {
    assert.equal(normalizePhone(v), '972500000001', String(v));
  }
});

test('normalizePhone rejects non-mobile and junk', () => {
  for (const v of ['03-0000001', '12345', '', null, undefined, '050-000000', '05000000012']) {
    assert.equal(normalizePhone(v), null, String(v));
  }
});

test('parseContactsWorkbook reads name and phone, skipping empty rows and phoneless names', async () => {
  const buf = await buildContactsFixture([
    ['אבי דמה', '050-0000001', 'x'],
    [null, null, null],
    ['בני דמה', null, null],
    ['גדי דמה', 500000003, null],
  ]);
  const { contacts, errors } = await parseContactsWorkbook(buf);
  assert.deepEqual(contacts, [
    { name: 'אבי דמה', phone: '972500000001' },
    { name: 'גדי דמה', phone: '972500000003' },
  ]);
  assert.deepEqual(errors, []);
});

test('parseContactsWorkbook handles swapped columns and title rows', async () => {
  const buf = await buildContactsFixture([['0500000001', 'אבי דמה']], { headers: ['טלפון', 'שם'], titleRows: 2 });
  const { contacts } = await parseContactsWorkbook(buf);
  assert.deepEqual(contacts, [{ name: 'אבי דמה', phone: '972500000001' }]);
});

test('parseContactsWorkbook reports invalid phone with Excel row number', async () => {
  const buf = await buildContactsFixture([['אבי דמה', '050-0000001'], ['בני דמה', '12345']], { titleRows: 2 });
  const { contacts, errors } = await parseContactsWorkbook(buf);
  assert.equal(contacts.length, 1);
  assert.deepEqual(errors, [{ row: 5, message: 'שורה 5: מספר טלפון לא תקין' }]);
});

test('parseContactsWorkbook reports duplicate names and drops both', async () => {
  const buf = await buildContactsFixture([
    ['אבי דמה', '050-0000001'],
    ['גדי דמה', '050-0000002'],
    ['אבי דמה', '050-0000003'],
  ]);
  const { contacts, errors } = await parseContactsWorkbook(buf);
  assert.deepEqual(contacts, [{ name: 'גדי דמה', phone: '972500000002' }]);
  assert.deepEqual(errors, [{ row: 4, message: 'שורה 4: השם מופיע פעמיים' }]);
});

test('parseContactsWorkbook with no usable sheet returns an error', async () => {
  const buf = await buildContactsFixture([['a', 'b']], { headers: ['x', 'y'] });
  const { contacts, errors } = await parseContactsWorkbook(buf);
  assert.deepEqual(contacts, []);
  assert.equal(errors.length, 1);
});

const sol = (key, name, spellings = [name]) => ({ key, name, spellings });

test('matchContacts: exact, spelling variant, short form, ambiguous', () => {
  const contacts = [
    { name: 'אבי דמה', phone: '972500000001' },
    { name: 'נווה דמה', phone: '972500000002' },
    { name: 'אור כהן דמה', phone: '972500000003' },
    { name: 'דנה לוי דמה', phone: '972500000004' },
    { name: 'דנה לוי דמה', phone: '972500000005' },
  ];
  const m = matchContacts(
    [sol('a', 'אבי דמה'), sol('n', 'נוה דמה'), sol('k', 'כהן דמה'), sol('d', 'דנה לוי דמה'), sol('z', 'זיו דמה')],
    contacts,
  );
  assert.deepEqual(m.get('a'), { status: 'ok', phone: '972500000001' });
  assert.deepEqual(m.get('n'), { status: 'ok', phone: '972500000002' });
  assert.deepEqual(m.get('k'), { status: 'none' }); // a short form is not the full contact name
  assert.deepEqual(m.get('d'), { status: 'ambiguous' });
  assert.deepEqual(m.get('z'), { status: 'none' });
});

test('matchContacts uses any spelling', () => {
  const m = matchContacts([sol('a', 'אבי דמה', ['אבי דמה', 'נווה דמה'])], [{ name: 'נווה דמה', phone: '972500000002' }]);
  assert.equal(m.get('a').status, 'ok');
});

test('matchContacts: a contact that is the only hit of two soldiers makes both ambiguous', () => {
  const m = matchContacts(
    [sol('a', 'נווה דמה'), sol('b', 'נוה דמה'), sol('c', 'גדי דמה')],
    [{ name: 'נווה דמה', phone: '972500000001' }, { name: 'גדי דמה', phone: '972500000002' }],
  );
  assert.deepEqual(m.get('a'), { status: 'ambiguous' });
  assert.deepEqual(m.get('b'), { status: 'ambiguous' });
  assert.deepEqual(m.get('c'), { status: 'ok', phone: '972500000002' });
});

test('parseContactsWorkbook: valid phone with an empty name says the name is missing', async () => {
  const buf = await buildContactsFixture([[null, '050-0000001'], ['אבי דמה', '050-0000002']]);
  const { contacts, errors } = await parseContactsWorkbook(buf);
  assert.equal(contacts.length, 1);
  assert.deepEqual(errors, [{ row: 2, message: 'שורה 2: חסר שם' }]);
});

test('normalizePhone accepts a 00972 prefix', () => {
  assert.equal(normalizePhone('00972-50-000-0001'), '972500000001');
});
