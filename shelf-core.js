(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.ShelfCore = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  function localDateKey(date = new Date()) {
    return [
      date.getFullYear(),
      String(date.getMonth() + 1).padStart(2, '0'),
      String(date.getDate()).padStart(2, '0'),
    ].join('-');
  }

  function previousLocalDateKey(date = new Date()) {
    return localDateKey(new Date(date.getFullYear(), date.getMonth(), date.getDate() - 1));
  }

  function normalizeBook(book) {
    const normalized = { ...book };
    normalized.currentPage = Math.max(0, Number(normalized.currentPage) || 0);
    normalized.pageCount = Number(normalized.pageCount) > 0 ? Number(normalized.pageCount) : null;
    if (normalized.pageCount) {
      normalized.currentPage = normalized.status === 'read'
        ? normalized.pageCount
        : Math.min(normalized.currentPage, normalized.pageCount);
    }
    if (normalized.status !== 'read') normalized.rating = 0;
    return normalized;
  }

  function updateStreak(streak, date = new Date(), recordReading = false) {
    const next = {
      lastDate: String(streak?.lastDate || ''),
      count: Math.max(0, Number(streak?.count) || 0),
    };
    const today = localDateKey(date);
    if (next.lastDate === today) return next;
    const yesterday = previousLocalDateKey(date);
    if (recordReading) {
      next.count = next.lastDate === yesterday ? next.count + 1 : 1;
      next.lastDate = today;
    } else if (next.lastDate && next.lastDate !== yesterday) {
      next.count = 0;
    }
    return next;
  }

  function versionParts(value) {
    return String(value || '').replace(/^v/i, '').split(/[.+-]/).slice(0, 3).map((part) => Number(part) || 0);
  }

  function isNewerVersion(candidate, current) {
    const next = versionParts(candidate);
    const installed = versionParts(current);
    for (let i = 0; i < 3; i++) {
      if ((next[i] || 0) !== (installed[i] || 0)) return (next[i] || 0) > (installed[i] || 0);
    }
    return false;
  }

  function validateBackup(value) {
    if (!value || value.format !== 'shelf-backup' || value.version !== 1 || !Array.isArray(value.books)) {
      throw new Error('This is not a supported Shelf backup.');
    }
    const ids = new Set();
    const books = value.books.map((book) => {
      if (!book || typeof book !== 'object' || typeof book.id !== 'string' || typeof book.title !== 'string') {
        throw new Error('The backup contains an invalid book.');
      }
      if (ids.has(book.id)) throw new Error('The backup contains duplicate book IDs.');
      ids.add(book.id);
      return normalizeBook(book);
    });
    const progress = value.progress && typeof value.progress === 'object' && Array.isArray(value.progress.quests)
      ? value.progress
      : { xp: 0, quests: [] };
    const streak = value.streak && typeof value.streak === 'object'
      ? { lastDate: String(value.streak.lastDate || ''), count: Math.max(0, Number(value.streak.count) || 0) }
      : { lastDate: '', count: 0 };
    return {
      books,
      progress,
      streak,
    };
  }

  return { localDateKey, previousLocalDateKey, normalizeBook, updateStreak, isNewerVersion, validateBackup };
});
