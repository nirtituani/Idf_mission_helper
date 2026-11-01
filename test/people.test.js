import test from 'node:test';
import assert from 'node:assert/strict';
import { identifySoldiers, nameRelation } from '../src/core/people.js';
import { matchKey } from '../src/core/text.js';

test('almost identical → same soldier', () => {
  for (const [a, b] of [
    ['אורי-אור כהנא', 'אורי אור כהנא'], // hyphen vs space
    ['שגיא לוינסון*', 'שגיא לוינסון'], // marker
    ['נוה ברק', 'נווה ברק'], // ו doubling
    ['עידו ברקוביץ', 'עידו ברקוביץה'], // one letter missing
    ['אסף ליבוביץ', 'אסף ליפוביץ'], // one letter changed in last name
    ["ג'ו דה מורה", 'גו דה מוראה'], // apostrophe + one letter
    ['אור זדה', 'אור זאדה'], // missing vowel letter in a short last name
    ['דן ימהרן', 'דן יהמרן'], // two adjacent letters swapped
    ['נועם כהן', 'נעם כהן'], // first name with/without a vowel letter inside, same last name
    ['מיכאל לוי', 'מכאל לוי'],
  ]) assert.equal(nameRelation(a, b), 'same', `${a} / ${b}`);
});

test('not almost identical → never merged', () => {
  assert.equal(nameRelation('דוד אדמוני', 'דוד מימוני'), null); // different last names (2 letters)
  assert.equal(nameRelation('נועה כהן', 'נועה לוי'), null);
  assert.equal(nameRelation('רון דמה', 'שי דמה'), null);
  assert.equal(nameRelation('נוי דמה', 'נוה דמה'), null); // first names one letter apart: different people
  assert.equal(nameRelation('רון דמה', 'רן דמה'), null); // 2-letter spelling: different names
  assert.equal(nameRelation('דן דמה', 'דני דמה'), null); // vowel letter at the end: different names
  assert.equal(nameRelation('נועם כהן', 'נעם לוי'), null); // different last names
  assert.equal(nameRelation('טל כהן', 'טל כהו'), null); // last name too short to tolerate a typo
  assert.equal(nameRelation('נתנאל צמל', 'נתנאל תצל'), null); // two different letters: maybe another person
  assert.equal(nameRelation('דוד לוי', 'דוד לוין'), null); // extra non-vowel letter on a short name
  assert.equal(nameRelation('רון אבירם', 'רון אבירמ'), 'same'); // final/regular form handled as one-letter typo
  // Possibly the same, but only reported:
  assert.equal(nameRelation('דמה', 'אור דמה'), 'related');
  assert.equal(nameRelation('אלון', 'אלון בדיה'), 'related');
  assert.equal(nameRelation('מתן בדיה', 'מתן בדיה(הערה)'), 'related');
  assert.equal(nameRelation('יואב בדיה', 'יואב בדיה/רז דמה'), 'related');
});

test('short form is merged only when exactly one soldier matches', () => {
  const make = (names) => names.map((n, i) => ({ id: `a${i + 1}`, soldier: n, soldierKey: matchKey(n) }));
  const unique = make(['בדיה', 'אור בדיה', 'דני כהן']);
  identifySoldiers(unique);
  assert.equal(unique[0].person, 'אור בדיה');
  const ambiguous = make(['דוד', 'דוד כהן', 'דוד לוי']);
  const { related } = identifySoldiers(ambiguous);
  assert.equal(ambiguous[0].person, 'דוד');
  assert.equal(related.length, 2);
});
