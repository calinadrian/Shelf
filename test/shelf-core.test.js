'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { localDateKey, previousLocalDateKey, normalizeBook, updateStreak, validateBackup } = require('../shelf-core.js');

test('date keys use local calendar values', () => {
  const date = new Date(2026, 0, 1, 0, 30);
  assert.equal(localDateKey(date), '2026-01-01');
  assert.equal(previousLocalDateKey(date), '2025-12-31');
});

test('read books are completed and unfinished books are clamped', () => {
  assert.equal(normalizeBook({ status: 'read', currentPage: 0, pageCount: 320 }).currentPage, 320);
  assert.equal(normalizeBook({ status: 'reading', currentPage: 500, pageCount: 320 }).currentPage, 320);
});

test('ratings are cleared unless a book is read', () => {
  assert.equal(normalizeBook({ status: 'want', rating: 5 }).rating, 0);
  assert.equal(normalizeBook({ status: 'read', rating: 5 }).rating, 5);
});

test('opening the app does not extend a streak without reading', () => {
  const today = new Date(2026, 7, 21, 12);
  assert.deepEqual(updateStreak({ lastDate: '2026-08-20', count: 4 }, today), { lastDate: '2026-08-20', count: 4 });
  assert.deepEqual(updateStreak({ lastDate: '2026-08-20', count: 4 }, today, true), { lastDate: '2026-08-21', count: 5 });
});

test('a stale streak resets and a new reading starts at one', () => {
  const today = new Date(2026, 7, 21, 12);
  assert.equal(updateStreak({ lastDate: '2026-08-18', count: 9 }, today).count, 0);
  assert.deepEqual(updateStreak({ lastDate: '2026-08-18', count: 9 }, today, true), { lastDate: '2026-08-21', count: 1 });
});

test('backup validation rejects unsupported and duplicate data', () => {
  assert.throws(() => validateBackup({}), /supported Shelf backup/);
  assert.throws(() => validateBackup({ format: 'shelf-backup', version: 1, books: [
    { id: '1', title: 'One' }, { id: '1', title: 'Two' },
  ] }), /duplicate book IDs/);
});

test('backup validation supplies safe progress defaults', () => {
  const backup = validateBackup({ format: 'shelf-backup', version: 1, books: [{ id: '1', title: 'One' }] });
  assert.deepEqual(backup.progress, { xp: 0, quests: [] });
  assert.deepEqual(backup.streak, { lastDate: '', count: 0 });
});
