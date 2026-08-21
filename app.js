'use strict';

/* ============================================================
   Shelf — a single-page book tracker
   Persistence: IndexedDB (Storage API) · Data: Open Library
   ============================================================ */

/* ---------------- IndexedDB layer ---------------- */

const DB_NAME = 'shelf-books';
const STORE_NAME = 'books';
let dbPromise = null;

function openDB() {
  if (!dbPromise) {
    dbPromise = new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, 1);
      req.onupgradeneeded = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains(STORE_NAME)) {
          const store = db.createObjectStore(STORE_NAME, { keyPath: 'id' });
          store.createIndex('byOlKey', 'olKey', { unique: false });
        }
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }
  return dbPromise;
}

function dbGetAll() {
  return openDB().then((db) => new Promise((resolve, reject) => {
    const req = db.transaction(STORE_NAME, 'readonly').objectStore(STORE_NAME).getAll();
    req.onsuccess = () => resolve(req.result || []);
    req.onerror = () => reject(req.error);
  }));
}

function dbPut(book) {
  return openDB().then((db) => new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, 'readwrite');
    tx.objectStore(STORE_NAME).put(book);
    tx.oncomplete = () => resolve(book);
    tx.onerror = () => reject(tx.error);
  }));
}

function dbDelete(id) {
  return openDB().then((db) => new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, 'readwrite');
    tx.objectStore(STORE_NAME).delete(id);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  }));
}

/* ---------------- State & constants ---------------- */

const STATUSES = [
  { value: 'want', label: 'Want to Read' },
  { value: 'reading', label: 'Currently Reading' },
  { value: 'read', label: 'Read' },
  { value: 'dnf', label: 'DNF' },
];

let library = [];        // every saved book
let lastDocs = [];       // latest search results (normalized)
let lastQuery = '';      // latest search query
let statusFilter = '';   // '' = all statuses
let libraryQuery = '';
let sortBy = 'addedDesc';
const LIBRARY_VIEW_KEY = 'shelf-library-view';
let libraryView = (() => {
  try { return localStorage.getItem(LIBRARY_VIEW_KEY) === 'list' ? 'list' : 'grid'; }
  catch { return 'grid'; }
})();
let modalBook = null;    // book being added/edited in the modal
let modalRating = 0;
let saveInFlight = false;
let calendarTarget = null;
let calendarMonth = new Date(new Date().getFullYear(), new Date().getMonth(), 1);
const PROGRESS_KEY = 'shelf-progress';
const STREAK_KEY = 'shelf-streak';

/* ---------------- Small helpers ---------------- */

const $ = (sel) => document.querySelector(sel);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const statusLabel = (v) => (STATUSES.find((s) => s.value === v) || {}).label || '';

const QUEST_ICONS = {
  'daily-page': '📖',
  'weekly-finish': '🎯',
  'weekly-pages': '📚',
  'monthly-books': '🏅',
  'monthly-pages': '📈',
  'finish-book': '📕',
  'read-bit': '📝',
};

const QUEST_PERIOD_LABELS = {
  'daily-page': 'daily',
  'weekly-finish': 'weekly',
  'weekly-pages': 'weekly',
  'monthly-books': 'monthly',
  'monthly-pages': 'monthly',
  'finish-book': 'book',
  'read-bit': 'book',
};

function loadProgress() {
  try { return JSON.parse(localStorage.getItem(PROGRESS_KEY)) || { xp: 0, quests: [] }; }
  catch { return { xp: 0, quests: [] }; }
}

function saveProgress(progress) {
  try { localStorage.setItem(PROGRESS_KEY, JSON.stringify(progress)); } catch { /* private mode */ }
}

/* ---------------- Streak tracking ---------------- */

function loadStreak() {
  try { return JSON.parse(localStorage.getItem(STREAK_KEY)) || { lastDate: '', count: 0 }; }
  catch { return { lastDate: '', count: 0 }; }
}

function saveStreak(streak) {
  try { localStorage.setItem(STREAK_KEY, JSON.stringify(streak)); } catch { /* private mode */ }
}

function checkStreak() {
  const streak = loadStreak();
  const today = dateKey();
  const yesterday = new Date(Date.now() - 86400000).toISOString().slice(0, 10);
  if (streak.lastDate === today) return streak; // already counted today
  if (streak.lastDate === yesterday) {
    streak.count += 1;
    streak.lastDate = today;
  } else if (streak.lastDate !== today) {
    // If last date is more than yesterday, streak is broken
    if (streak.lastDate && streak.lastDate !== yesterday) {
      streak.count = 0;
    }
  }
  saveStreak(streak);
  return streak;
}

function recordDailyRead() {
  const streak = loadStreak();
  const today = dateKey();
  if (streak.lastDate === today) return streak.count; // already recorded
  const yesterday = new Date(Date.now() - 86400000).toISOString().slice(0, 10);
  if (streak.lastDate === yesterday || streak.count === 0) {
    streak.count += 1;
  } else {
    streak.count = 1;
  }
  streak.lastDate = today;
  saveStreak(streak);
  return streak.count;
}

function renderStreak() {
  const streak = checkStreak();
  const el = document.querySelector('.streak-bar');
  const countEl = $('#streakCount');
  const hintEl = $('#streakHint');
  if (!el) return;
  countEl.textContent = streak.count;
  if (streak.count === 0) {
    el.classList.add('zero');
    hintEl.textContent = 'Read today to start your streak!';
  } else if (streak.count === 1) {
    el.classList.remove('zero');
    hintEl.textContent = 'Read today to keep it going!';
  } else if (streak.count < 5) {
    el.classList.remove('zero');
    hintEl.textContent = `${streak.count} days — keep it up!`;
  } else if (streak.count < 14) {
    el.classList.remove('zero');
    hintEl.textContent = `${streak.count} days — on fire! 🔥`;
  } else if (streak.count < 30) {
    el.classList.remove('zero');
    hintEl.textContent = `${streak.count} days — unstoppable! 💪`;
  } else {
    el.classList.remove('zero');
    hintEl.textContent = `${streak.count} days — legendary! 👑`;
  }
}

function levelForXp(xp) { return Math.floor(xp / 100) + 1; }

function addXp(amount) {
  const progress = loadProgress();
  progress.xp += amount;
  saveProgress(progress);
  renderProgress();
}

let recentlyCompletedQuestId = null;

function awardQuest(progress, quest) {
  if (quest.status !== 'complete') {
    quest.status = 'complete';
    progress.xp += quest.xp;
    recentlyCompletedQuestId = quest.id;
  }
}

function createBookQuest(book) {
  const progress = loadProgress();
  const startPages = book.currentPage || 0;
    progress.quests.push({ id: newId(), type: 'finish-book', bookId: book.id, title: `Finish ${book.title} in 3 days`, description: 'Set this book to Read before the countdown ends.', xp: 50, expiresAt: Date.now() + 3 * 24 * 60 * 60 * 1000, status: 'active' });
    progress.quests.push({ id: newId(), type: 'read-bit', bookId: book.id, title: `Read a bit of ${book.title}`, description: 'Read a few pages, then update Current page in the book details.', startPages, xp: 20, status: 'active' });
  saveProgress(progress);
}

function weekKey(date = new Date()) {
  const first = new Date(date.getFullYear(), 0, 1);
  return `${date.getFullYear()}-${Math.ceil((((date - first) / 86400000) + first.getDay() + 1) / 7)}`;
}

function dateKey(date = new Date()) { return date.toISOString().slice(0, 10); }
function monthKey(date = new Date()) { return `${date.getFullYear()}-${date.getMonth() + 1}`; }
function periodEnd(type, date = new Date()) {
  if (type === 'daily') return new Date(date.getFullYear(), date.getMonth(), date.getDate() + 1).getTime();
  if (type === 'weekly') return new Date(date.getFullYear(), date.getMonth(), date.getDate() + (7 - date.getDay())).getTime();
  return new Date(date.getFullYear(), date.getMonth() + 1, 1).getTime();
}

function reconcileRecurringQuests() {
  const progress = loadProgress();
  const today = dateKey();
  const week = weekKey();
  const month = monthKey();
  const pages = library.reduce((sum, book) => sum + (book.currentPage || 0), 0);
  if (progress.suppressRecurring?.daily !== today && !progress.quests.some((quest) => quest.type === 'daily-page' && quest.period === today)) {
    progress.quests.push({ id: newId(), type: 'daily-page', period: today, title: 'Read a page', description: 'Move any book’s Current page forward by at least one page.', xp: 15, startPages: pages, expiresAt: periodEnd('daily'), status: 'active' });
  }
  if (progress.suppressRecurring?.weekly !== week && !progress.quests.some((quest) => quest.type === 'weekly-finish' && quest.period === week)) {
    progress.quests.push({ id: newId(), type: 'weekly-finish', period: week, title: 'Finish any book this week', description: 'Set any book to Read before the weekly countdown ends.', xp: 75, expiresAt: periodEnd('weekly'), status: 'active' });
  }
  if (progress.suppressRecurring?.weekly !== week && !progress.quests.some((quest) => quest.type === 'weekly-pages' && quest.period === week)) {
    progress.quests.push({ id: newId(), type: 'weekly-pages', period: week, title: 'Read 200 pages', description: 'Advance your Current page totals by 200 pages this week.', xp: 60, startPages: pages, expiresAt: periodEnd('weekly'), status: 'active' });
  }
  if (progress.suppressRecurring?.monthly !== month && !progress.quests.some((quest) => quest.type === 'monthly-books' && quest.period === month)) {
    progress.quests.push({ id: newId(), type: 'monthly-books', period: month, title: 'Finish 3 books', description: 'Finish three books before the month ends.', xp: 150, expiresAt: periodEnd('monthly'), status: 'active' });
  }
  if (progress.suppressRecurring?.monthly !== month && !progress.quests.some((quest) => quest.type === 'monthly-pages' && quest.period === month)) {
    progress.quests.push({ id: newId(), type: 'monthly-pages', period: month, title: 'Read 1,000 pages', description: 'Advance your Current page totals by 1,000 pages this month.', xp: 200, startPages: pages, expiresAt: periodEnd('monthly'), status: 'active' });
  }
  const todayQuest = progress.quests.find((quest) => quest.type === 'daily-page' && quest.period === today && quest.status === 'active');
  if (todayQuest && library.reduce((sum, book) => sum + (book.currentPage || 0), 0) > todayQuest.startPages) awardQuest(progress, todayQuest);
  const weeklyQuest = progress.quests.find((quest) => quest.type === 'weekly-finish' && quest.period === week && quest.status === 'active');
  if (weeklyQuest && library.some((book) => book.status === 'read' && book.finishDate && weekKey(new Date(`${book.finishDate}T00:00:00`)) === week)) awardQuest(progress, weeklyQuest);
  const weeklyPages = progress.quests.find((quest) => quest.type === 'weekly-pages' && quest.period === week && quest.status === 'active');
  if (weeklyPages && pages >= weeklyPages.startPages + 200) awardQuest(progress, weeklyPages);
  const monthlyBooks = progress.quests.find((quest) => quest.type === 'monthly-books' && quest.period === month && quest.status === 'active');
  if (monthlyBooks && library.filter((book) => book.status === 'read' && book.finishDate && monthKey(new Date(`${book.finishDate}T00:00:00`)) === month).length >= 3) awardQuest(progress, monthlyBooks);
  const monthlyPages = progress.quests.find((quest) => quest.type === 'monthly-pages' && quest.period === month && quest.status === 'active');
  if (monthlyPages && pages >= monthlyPages.startPages + 1000) awardQuest(progress, monthlyPages);
  library.forEach((book) => {
    const quest = progress.quests.find((item) => item.type === 'finish-book' && item.bookId === book.id && item.status === 'active');
    if (quest && book.status === 'read') awardQuest(progress, quest);
    if (quest && quest.expiresAt < Date.now()) quest.status = 'failed';
    const readBit = progress.quests.find((item) => item.type === 'read-bit' && item.bookId === book.id && item.status === 'active');
    if (readBit && (book.currentPage || 0) > readBit.startPages) awardQuest(progress, readBit);
  });
  saveProgress(progress);
}

function renderProgress() {
  reconcileRecurringQuests();
  const progress = loadProgress();
  const level = levelForXp(progress.xp);
  const current = progress.xp % 100;
  $('#levelNumber').textContent = String(level);
  $('#xpNumber').textContent = `${progress.xp} XP`;
  $('#xpNext').textContent = `${100 - current || 100} XP to level ${level + 1}`;
  $('#xpBar').style.width = `${current}%`;

  // Count active vs history
  const activeQuests = progress.quests.filter((q) => q.status === 'active');
  const historyQuests = progress.quests.filter((q) => q.status === 'complete' || q.status === 'failed' || q.status === 'abandoned');
  $('#activeCount').textContent = activeQuests.length;
  $('#historyCount').textContent = historyQuests.length;

  // Streak
  renderStreak();

  // Render quest tabs
  const activeTab = document.querySelector('.quest-tab.active')?.dataset.questtab || 'active';
  renderQuestList(progress, activeTab);

  saveProgress(progress);
}

function renderQuestList(progress, tab) {
  const container = $('#questList');
  let quests;

  if (tab === 'active') {
    quests = progress.quests.filter((q) => q.status === 'active').slice(-20).reverse();
  } else {
    quests = progress.quests.filter((q) => q.status === 'complete' || q.status === 'failed' || q.status === 'abandoned').slice(-30).reverse();
  }

  if (!quests.length) {
    const icon = tab === 'active' ? '📚' : '🏆';
    const msg = tab === 'active' ? 'Add a book to start a quest.' : 'No completed quests yet. Happy reading!';
    container.innerHTML = `<div class="quest-empty"><span class="quest-empty-icon">${icon}</span>${msg}</div>`;
    return;
  }

  const now = Date.now();
  container.innerHTML = quests.map((quest) => {
    const icon = QUEST_ICONS[quest.type] || '📖';
    const periodLabel = QUEST_PERIOD_LABELS[quest.type] || 'daily';
    const isDone = quest.status === 'complete';
    const isFailed = quest.status === 'failed';
    const isAbandoned = quest.status === 'abandoned';

    // Calculate progress
    const progressInfo = getQuestProgress(quest);

    let metaHtml = '';
    if (isDone) {
      metaHtml = `<span class="quest-xp">+${quest.xp} XP</span>`;
    } else if (isFailed) {
      metaHtml = `<span class="quest-failed">Failed</span>`;
    } else if (isAbandoned) {
      metaHtml = `<span class="quest-abandoned">Abandoned</span>`;
    } else {
      metaHtml = `<span class="quest-xp">${quest.xp} XP</span>`;
    }

    let countdownHtml = '';
    if (!isDone && !isFailed && !isAbandoned && quest.expiresAt) {
      countdownHtml = `<span class="quest-countdown ${Math.ceil((quest.expiresAt - now) / 86400000) > 1 ? 'safe' : ''}">${Math.max(0, Math.ceil((quest.expiresAt - now) / 86400000))}d left</span>`;
    }

    // Progress info (always show for active quests)
    let progressText = '';
    let progressBarHtml = '';
    if (progressInfo && progressInfo.max > 0) {
      const pct = Math.min(100, Math.round((progressInfo.current / progressInfo.max) * 100));
      if (!isDone && !isFailed && !isAbandoned) {
        progressText = `<span class="quest-progress-text">${progressInfo.current} / ${progressInfo.max} ${progressInfo.unit}</span>`;
        progressBarHtml = `<div class="quest-progress-track"><span class="quest-progress-fill ${periodLabel}" style="width: ${pct}%"></span></div>`;
      } else {
        progressText = `<span class="quest-progress-text">${progressInfo.current} / ${progressInfo.max} ${progressInfo.unit}</span>`;
      }
    }

    // Action buttons for active quests
    let actionsHtml = '';
    if (quest.status === 'active') {
      actionsHtml = `<button class="quest-action-btn danger" data-quest-id="${quest.id}" aria-label="Abandon quest">✕</button>`;
    } else if (isDone) {
      actionsHtml = `<span class="quest-complete">✓</span>`;
    } else if (isFailed) {
      actionsHtml = `<span class="quest-failed">✕</span>`;
    } else if (isAbandoned) {
      actionsHtml = `<span class="quest-abandoned">—</span>`;
    }

    return `
      <article class="quest${isDone || isFailed || isAbandoned ? ' quest-done' : ''}" data-quest-id="${quest.id}">
        <span class="quest-icon" aria-hidden="true">${icon}</span>
        <div class="quest-body">
          <div class="quest-header">
            <span class="quest-title">${esc(quest.title)}</span>
            <span class="quest-badge ${periodLabel}">${periodLabel}</span>
            ${metaHtml}
          </div>
          <p class="quest-description">${esc(quest.description || 'Make progress in your library.')}</p>
          ${progressText || progressBarHtml || countdownHtml ? `<div class="quest-footer">${progressText}${countdownHtml}${progressBarHtml}</div>` : ''}
        </div>
        <div class="quest-actions">${actionsHtml}</div>
      </article>`;
  }).join('');
}

function getQuestProgress(quest) {
  if (quest.type === 'daily-page') {
    const pages = library.reduce((sum, book) => sum + (book.currentPage || 0), 0);
    const current = Math.max(0, pages - quest.startPages);
    return { current, max: 1, unit: 'page(s)', progress: current >= 1 };
  }
  if (quest.type === 'weekly-pages') {
    const pages = library.reduce((sum, book) => sum + (book.currentPage || 0), 0);
    const current = Math.max(0, pages - quest.startPages);
    return { current, max: 200, unit: 'pages', progress: current >= 200 };
  }
  if (quest.type === 'monthly-pages') {
    const pages = library.reduce((sum, book) => sum + (book.currentPage || 0), 0);
    const current = Math.max(0, pages - quest.startPages);
    return { current, max: 1000, unit: 'pages', progress: current >= 1000 };
  }
  if (quest.type === 'weekly-finish' || quest.type === 'monthly-books') {
    // Can't easily show progress, but we can show count
    const readBooks = library.filter((b) => b.status === 'read');
    const target = quest.type === 'monthly-books' ? 3 : 1;
    return { current: readBooks.length, max: target, unit: 'books', progress: readBooks.length >= target };
  }
  if (quest.type === 'finish-book') {
    const book = library.find((b) => b.id === quest.bookId);
    if (book && book.status === 'read') return { current: 1, max: 1, unit: '', progress: true };
    if (book) {
      const pct = book.pageCount ? Math.round(((book.currentPage || 0) / book.pageCount) * 100) : 0;
      return { current: pct, max: 100, unit: '%', progress: false };
    }
    return { current: 0, max: 1, unit: '', progress: false };
  }
  if (quest.type === 'read-bit') {
    const book = library.find((b) => b.id === quest.bookId);
    if (book) {
      const current = Math.max(0, (book.currentPage || 0) - quest.startPages);
      return { current, max: 1, unit: 'page(s)', progress: current >= 1 };
    }
    return { current: 0, max: 1, unit: '', progress: false };
  }
  return null;
}

function abandonQuest(questId) {
  const progress = loadProgress();
  const quest = progress.quests.find((q) => q.id === questId);
  if (!quest || quest.status !== 'active') return;
  quest.status = 'abandoned';
  saveProgress(progress);
  renderProgress();
  toast('Quest abandoned');
}

function abandonAllQuests() {
  if (!window.confirm('Abandon all current quests?')) return;
  const progress = loadProgress();
  progress.quests = progress.quests.map((quest) => quest.status === 'active' ? { ...quest, status: 'abandoned' } : quest);
  progress.suppressRecurring = { daily: dateKey(), weekly: weekKey(), monthly: monthKey() };
  saveProgress(progress);
  renderProgress();
  toast('All current quests abandoned');
}

function resetAllProgress() {
  if (!window.confirm('Reset XP, levels, and all quest history?')) return;
  saveProgress({ xp: 0, quests: [] });
  renderProgress();
  toast('Progress reset');
}

function newId() {
  if (window.crypto && typeof crypto.randomUUID === 'function') return crypto.randomUUID();
  return Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 10);
}

function coverUrlFor(coverI, size = 'M') {
  return coverI ? `https://covers.openlibrary.org/b/id/${coverI}-${size}.jpg` : null;
}

/* Cover image with a graceful fallback when a book has no cover art. */
function coverMarkup(url, alt) {
  const fallback = `<div class="cover-fallback${url ? ' hidden' : ''}"><span>${esc(alt)}</span></div>`;
  if (!url) return fallback;
  return (
    `<img src="${esc(url)}" alt="" loading="lazy" ` +
    `onerror="this.remove();const f=this.previousElementSibling;if(f)f.classList.remove('hidden')" />` +
    fallback
  );
}

async function cacheCover(book) {
  if (!book.coverUrl || book.coverData) return book;
  try {
    const response = await fetch(book.coverUrl, { mode: 'cors' });
    if (!response.ok) return book;
    const blob = await response.blob();
    book.coverData = await new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(reader.result);
      reader.onerror = reject;
      reader.readAsDataURL(blob);
    });
  } catch {
    // Keep the remote URL as a fallback when the cover cannot be cached.
  }
  return book;
}

function starsMarkup(rating) {
  let out = '';
  for (let i = 1; i <= 5; i++) out += `<span class="star${i <= rating ? ' on' : ''}">★</span>`;
  return out;
}

let toastTimer = null;
function toast(msg) {
  const el = $('#toast');
  el.textContent = msg;
  el.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove('show'), 2400);
}

/* ---------------- Search (Open Library API) ---------------- */

function docToBook(doc) {
  return {
    olKey: doc.key || null,
    title: String(doc.title || '').trim(),
    author: Array.isArray(doc.author_name) ? doc.author_name.join(', ') : '',
    coverUrl: coverUrlFor(doc.cover_i),
    pageCount: typeof doc.number_of_pages_median === 'number' ? doc.number_of_pages_median : null,
    isbn: Array.isArray(doc.isbn) && doc.isbn.length ? String(doc.isbn[0]) : null,
    firstPublishYear: doc.first_publish_year || null,
    publisher: Array.isArray(doc.publisher) && doc.publisher.length ? String(doc.publisher[0]) : null,
    description: typeof doc.first_sentence === 'string' ? doc.first_sentence : null,
  };
}

async function runSearch(query) {
  const statusEl = $('#searchStatus');
  const listEl = $('#searchResults');
  lastQuery = query;
  statusEl.textContent = `Searching for “${query}”…`;
  listEl.hidden = true;
  try {
    const params = new URLSearchParams({
      q: query,
      limit: '24',
      fields: 'key,title,author_name,cover_i,number_of_pages_median,isbn,first_publish_year,publisher,first_sentence',
    });
    const res = await fetch(`https://openlibrary.org/search.json?${params.toString()}`);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    lastDocs = (data.docs || []).map(docToBook).filter((b) => b.title);
    renderSearchResults();
  } catch {
    lastDocs = [];
    statusEl.textContent = 'Could not reach Open Library. Check your connection and try again.';
  }
}

function renderSearchResults() {
  const listEl = $('#searchResults');
  const statusEl = $('#searchStatus');
  if (!lastQuery) return;
  if (!lastDocs.length) {
    statusEl.textContent = `No results for “${lastQuery}”.`;
    listEl.hidden = true;
    return;
  }
  statusEl.textContent = `Found ${lastDocs.length} book${lastDocs.length === 1 ? '' : 's'}`;
  const inLib = new Set(library.filter((b) => b.olKey).map((b) => b.olKey));
  listEl.innerHTML = lastDocs.map((b, i) => {
    const already = b.olKey && inLib.has(b.olKey);
    return `
      <li class="result" data-index="${i}" tabindex="0" role="button" aria-label="View details for ${esc(b.title)}">
        <div class="thumb">${coverMarkup(b.coverUrl, b.title)}</div>
        <div class="result-info">
          <h3 title="${esc(b.title)}">${esc(b.title)}</h3>
          <p>${esc(b.author || 'Unknown author')}${b.pageCount ? ` · ${b.pageCount} pages` : ''}</p>
        </div>
        ${already
          ? '<span class="result-action in-library">In library ✓</span>'
          : `<button type="button" class="btn btn-dark result-action add-btn" data-index="${i}">Add to Library</button>`}
      </li>`;
  }).join('');
  listEl.hidden = false;
}

/* ---------------- Library view ---------------- */

function visibleBooks() {
  let books = [...library];
  if (libraryQuery) {
    const query = libraryQuery.toLowerCase();
    books = books.filter((b) => `${b.title} ${b.author || ''}`.toLowerCase().includes(query));
  }
  if (statusFilter) books = books.filter((b) => b.status === statusFilter);
  const sorters = {
    addedDesc: (a, b) => new Date(b.addedAt).getTime() - new Date(a.addedAt).getTime(),
    ratingDesc: (a, b) => (b.rating || 0) - (a.rating || 0) || a.title.localeCompare(b.title),
    titleAsc: (a, b) => a.title.localeCompare(b.title),
  };
  return books.sort(sorters[sortBy] || sorters.addedDesc);
}

function renderLibrary() {
  const grid = $('#libraryGrid');
  const empty = $('#emptyLibrary');
  const books = visibleBooks();
  if (!books.length) {
    grid.innerHTML = '';
    empty.classList.remove('hidden');
    empty.textContent = library.length === 0
      ? 'Your library is empty — search for a book and add it to get started.'
      : 'No books match the current filters.';
    return;
  }
  empty.classList.add('hidden');
  grid.classList.toggle('list-view', libraryView === 'list');
  document.querySelectorAll('.view-toggle-btn').forEach((item) => {
    const active = item.dataset.view === libraryView;
    item.classList.toggle('active', active);
    item.setAttribute('aria-pressed', String(active));
  });
  grid.innerHTML = books.map((b) => `
    <article class="card" data-id="${esc(b.id)}" tabindex="0" aria-label="${esc(b.title)}">
      <div class="cover-wrap">
        ${coverMarkup(b.coverData || b.coverUrl, b.title)}
        <span class="badge badge-${esc(b.status || 'want')}">${esc(statusLabel(b.status))}</span>
      </div>
      <div class="card-details">
        <div class="list-title-row">
          <h3 class="card-title" title="${esc(b.title)}">${esc(b.title)}</h3>
          <span class="list-status badge badge-${esc(b.status || 'want')}">${esc(statusLabel(b.status))}</span>
        </div>
        <p class="card-author">${esc(b.author || '')}</p>
        <div class="card-meta">
          <div class="stars small">${b.rating ? starsMarkup(b.rating) : '<span class="muted">No rating</span>'}</div>
          <span class="page-progress">${b.currentPage || 0}${b.pageCount ? ` / ${b.pageCount} pages` : ' pages'}</span>
        </div>
      </div>
    </article>`).join('');
}

function renderStats() {
  const readBooks = library.filter((b) => b.status === 'read');
  const pagesRead = readBooks.reduce((sum, b) => sum + (b.pageCount || 0), 0);
  const rated = library.filter((b) => b.rating > 0);
  const avg = rated.length ? rated.reduce((s, b) => s + b.rating, 0) / rated.length : null;
  const year = new Date().getFullYear();
  const readThisYear = readBooks.filter(
    (b) => b.finishDate && Number(String(b.finishDate).slice(0, 4)) === year
  ).length;

  $('#statRead').textContent = String(readBooks.length);
  $('#statPages').textContent = pagesRead.toLocaleString();
  $('#statAvg').textContent = avg ? avg.toFixed(1) : '–';
  $('#statYear').textContent = String(readThisYear);
}

function renderStatusSelect() {
  $('#statusFilter').value = statusFilter;
}

/* ---------------- Modal (add / edit) ---------------- */

function openModal(book, mode) {
  modalBook = book;
  modalRating = book.rating || 0;

  $('#modalTitle').textContent = book.title;
  $('#modalAuthor').textContent = book.author || 'Unknown author';
  const meta = [];
  if (book.pageCount) meta.push(`${book.pageCount} pages`);
  if (book.isbn) meta.push(`ISBN ${book.isbn}`);
  if (book.firstPublishYear) meta.push(`Published ${book.firstPublishYear}`);
  if (book.publisher) meta.push(book.publisher);
  $('#modalMeta').textContent = meta.join(' · ');
  $('#modalDescription').textContent = book.description || '';
  $('#modalDescription').classList.toggle('hidden', !book.description);

  const cover = $('#mCover');
  if (book.coverUrl || book.coverData) { cover.src = book.coverData || book.coverUrl; cover.classList.remove('hidden'); }
  else cover.classList.add('hidden');

  $('#fStatus').value = STATUSES.some((s) => s.value === book.status) ? book.status : 'want';
  updateRatingVisibility();
  renderRatingInput();
  $('#fStart').value = book.startDate || '';
  $('#fFinish').value = book.finishDate || '';
  syncDateDisplay('fStart');
  syncDateDisplay('fFinish');
  // Clamp current page to total pages (silently, no browser popup)
  const total = book.pageCount || 0;
  const cp = $('#fCurrentPage');
  cp.value = Math.min(book.currentPage || 0, total) || '';
  const pc = $('#fPageCount');
  pc.value = book.pageCount || '';
  $('#fNotes').value = book.notes || '';
  $('#deleteBtn').classList.toggle('hidden', mode !== 'edit');

  $('#modalBackdrop').classList.remove('hidden');
  document.body.style.overflow = 'hidden';
}

function closeModal() {
  if ($('#modalBackdrop').classList.contains('hidden')) return;
  $('#modalBackdrop').classList.add('hidden');
  closeCalendar();
  modalBook = null;
  document.body.style.overflow = '';
}

/* Build the star row ONCE; subsequent hovers just toggle classes. Rewriting the
   buttons' innerHTML on every hover used to destroy the button under the cursor
   mid-sweep, racing with real pointer movement and making direct clicks do nothing. */
function renderRatingInput(value) {
  const wrap = $('#ratingInput');
  if (!wrap.querySelector('.star-btn')) {
    const initial = value || modalRating;
    let html = [1, 2, 3, 4, 5].map((i) =>
      `<button type="button" class="star-btn${i <= initial ? ' on' : ''}" data-star="${i}" aria-label="Rate ${i} star${i > 1 ? 's' : ''}">★</button>`
    ).join('');
    if (!initial) html += '<span class="muted small" data-rating-hint>No rating</span>';
    wrap.innerHTML = html;
  } else {
    toggleRatingStars(value || modalRating);
  }
}

function dateValue(date) {
  return [date.getFullYear(), String(date.getMonth() + 1).padStart(2, '0'), String(date.getDate()).padStart(2, '0')].join('-');
}

function dateFromValue(value) {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value || '');
  return match ? new Date(Number(match[1]), Number(match[2]) - 1, Number(match[3])) : null;
}

function syncDateDisplay(id) {
  const date = dateFromValue($(`#${id}`).value);
  $(`#${id}Display`).value = date
    ? new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric', year: 'numeric' }).format(date)
    : '';
}

/* Rating is only meaningful for books you've actually read. */
function updateRatingVisibility() {
  const isRead = $('#fStatus').value === 'read';
  $('#ratingField').hidden = !isRead;
  if (!isRead) {
    modalRating = 0;
    renderRatingInput();
  }
}

function renderCalendar() {
  const value = calendarTarget ? $(`#${calendarTarget}`).value : '';
  const selected = dateFromValue(value);
  const today = dateValue(new Date());
  $('#calendarMonth').textContent = new Intl.DateTimeFormat(undefined, { month: 'long', year: 'numeric' }).format(calendarMonth);
  const firstDay = new Date(calendarMonth.getFullYear(), calendarMonth.getMonth(), 1).getDay();
  const daysInMonth = new Date(calendarMonth.getFullYear(), calendarMonth.getMonth() + 1, 0).getDate();
  let html = '';
  for (let i = 0; i < firstDay; i++) html += '<span class="calendar-day empty" aria-hidden="true"></span>';
  for (let day = 1; day <= daysInMonth; day++) {
    const current = new Date(calendarMonth.getFullYear(), calendarMonth.getMonth(), day);
    const valueForDay = dateValue(current);
    const classes = ['calendar-day'];
    if (valueForDay === today) classes.push('today');
    if (selected && valueForDay === value) classes.push('selected');
    html += `<button type="button" class="${classes.join(' ')}" data-date="${valueForDay}">${day}</button>`;
  }
  $('#calendarDays').innerHTML = html;
}

function positionCalendar() {
  if (!calendarTarget) return;
  const popover = $('#calendarPopover');
  const target = $(`#${calendarTarget}Display`).getBoundingClientRect();
  const gap = 8;
  const edge = 16;
  const below = target.bottom + gap;
  const above = target.top - popover.offsetHeight - gap;
  const top = below + popover.offsetHeight <= window.innerHeight - edge
    ? below
    : Math.max(edge, above);
  const left = Math.max(edge, Math.min(target.left, window.innerWidth - popover.offsetWidth - edge));
  popover.style.right = 'auto';
  popover.style.bottom = 'auto';
  popover.style.top = `${Math.max(edge, top)}px`;
  popover.style.left = `${left}px`;
}

function openCalendar(id) {
  calendarTarget = id;
  const selected = dateFromValue($(`#${id}`).value) || new Date();
  calendarMonth = new Date(selected.getFullYear(), selected.getMonth(), 1);
  renderCalendar();
  $('#calendarPopover').classList.remove('hidden');
  positionCalendar();
}

function closeCalendar() {
  calendarTarget = null;
  $('#calendarPopover').classList.add('hidden');
}

function chooseDate(value) {
  if (!calendarTarget) return;
  $(`#${calendarTarget}`).value = value;
  syncDateDisplay(calendarTarget);
  closeCalendar();
}

function toggleRatingStars(rating) {
  const btns = $('#ratingInput').querySelectorAll('.star-btn');
  btns.forEach((b, idx) => b.classList.toggle('on', (idx + 1) <= rating));
  const hint = document.querySelector('#ratingInput [data-rating-hint]');
  if (hint) hint.classList.toggle('hidden', rating > 0);
}

async function saveFromModal() {
  if (!modalBook || saveInFlight) return;
  saveInFlight = true;
  const saveBtn = $('#saveBtn');
  saveBtn.disabled = true;
  saveBtn.textContent = 'Saving…';
  const wasNew = !modalBook.id;
  const book = { ...modalBook };
  book.id = modalBook.id || newId();
  book.status = $('#fStatus').value;
  book.rating = modalRating;
  book.notes = $('#fNotes').value.trim();
  book.tags = [];
  book.currentPage = Math.max(0, Number($('#fCurrentPage').value) || 0);
  const pageCount = Number($('#fPageCount').value);
  book.pageCount = pageCount > 0 ? pageCount : null;
  // Clamp current page to total pages
  if (book.pageCount && book.currentPage > book.pageCount) {
    book.currentPage = book.pageCount;
  }
  book.startDate = $('#fStart').value || null;
  book.finishDate = $('#fFinish').value || null;
  if (!book.addedAt) book.addedAt = new Date().toISOString();

  let storedBooks;
  try { storedBooks = await dbGetAll(); }
  catch { saveInFlight = false; saveBtn.disabled = false; saveBtn.textContent = 'Save'; toast('Could not check your library'); return; }
  const dup = storedBooks.find((b) => b.olKey && b.olKey === book.olKey && b.id !== book.id);
  if (dup) {
    toast('That book is already in your library');
    closeModal();
    saveInFlight = false;
    saveBtn.disabled = false;
    saveBtn.textContent = 'Save';
    return;
  }

  try {
    await cacheCover(book);
    await dbPut(book);
    if (wasNew) {
      addXp(20);
      createBookQuest(book);
    } else {
      // Record streak if the user updated page progress
      const oldBook = library.find((b) => b.id === book.id);
      if (oldBook && book.currentPage > (oldBook.currentPage || 0)) {
        const streak = recordDailyRead();
        if (streak > 0 && streak % 5 === 0) {
          toast(`🔥 ${streak}-day reading streak!`);
        }
      }
      // Check if a book was just finished (status changed to 'read')
      if (book.status === 'read' && oldBook && oldBook.status !== 'read') {
        addXp(50);
        toast(`🎉 Finished "${book.title}" — +50 XP`);
      }
    }
    closeModal();
    await reloadLibrary();
    toast(wasNew ? `Added “${book.title}” to your library` : 'Changes saved');
  } catch (err) {
    console.error('Save failed', err);
    toast('Could not save — local storage may be full or blocked');
  } finally {
    saveInFlight = false;
    saveBtn.disabled = false;
    saveBtn.textContent = 'Save';
  }
}

async function deleteFromModal() {
  if (!modalBook || !modalBook.id) return;
  const title = modalBook.title;
  await dbDelete(modalBook.id);
  const progress = loadProgress();
  progress.quests = progress.quests.map((quest) => quest.bookId === modalBook.id && quest.status === 'active' ? { ...quest, status: 'abandoned' } : quest);
  saveProgress(progress);
  closeModal();
  await reloadLibrary();
  toast(`Removed “${title}”`);
}

/* ---------------- Data refresh ---------------- */

async function reloadLibrary() {
  library = (await dbGetAll()).sort((a, b) => new Date(a.addedAt).getTime() - new Date(b.addedAt).getTime());
  refreshAll();
}

function refreshAll() {
  $('#libCount').textContent = library.length ? String(library.length) : '';
  renderStats();
  renderStatusSelect();
  renderLibrary();
  renderProgress();
  if (lastQuery) renderSearchResults(); // keep "In library" badges in sync
}

/* ---------------- Theme (dark mode) ---------------- */

const THEME_KEY = 'shelf-theme';

function currentTheme() {
  return document.documentElement.dataset.theme === 'dark' ? 'dark' : 'light';
}

function applyTheme(theme) {
  document.documentElement.dataset.theme = theme;
  // Keep the native status bar / TWA title bar in step with the app theme.
  document.querySelectorAll('meta[name="theme-color"]').forEach((m) => {
    m.setAttribute('content', theme === 'dark' ? '#161512' : '#f6f5f1');
  });
  const btn = $('#themeToggle');
  if (btn) {
    const label = theme === 'dark' ? 'Switch to light mode' : 'Switch to dark mode';
    btn.setAttribute('aria-label', label);
    btn.title = label;
  }
}

function bindThemeToggle() {
  applyTheme(currentTheme()); // sync icon/label with the pre-paint state
  const btn = $('#themeToggle');
  if (!btn) return;
  btn.addEventListener('click', () => {
    const next = currentTheme() === 'dark' ? 'light' : 'dark';
    applyTheme(next);
    try { localStorage.setItem(THEME_KEY, next); } catch { /* private mode */ }
  });
  // Follow OS scheme changes until the user picks a theme explicitly.
  const mq = window.matchMedia('(prefers-color-scheme: dark)');
  const followSystem = (e) => {
    let saved = null;
    try { saved = localStorage.getItem(THEME_KEY); } catch { /* ignore */ }
    if (saved !== 'dark' && saved !== 'light') applyTheme(e.matches ? 'dark' : 'light');
  };
  if (mq.addEventListener) mq.addEventListener('change', followSystem);
  else if (mq.addListener) mq.addListener(followSystem); // older Safari
}

/* ---------------- Tabs & events ---------------- */

function switchTab(name) {
  document.querySelectorAll('.tab').forEach((t) => t.classList.toggle('active', t.dataset.tab === name));
  $('#view-search').classList.toggle('active', name === 'search');
  $('#view-library').classList.toggle('active', name === 'library');
  $('#view-quests').classList.toggle('active', name === 'quests');
  if (name === 'quests') renderProgress();
}

function bindEvents() {
  // Tabs
  document.querySelectorAll('.tab').forEach((t) => t.addEventListener('click', () => switchTab(t.dataset.tab)));

  // Search form
  $('#searchForm').addEventListener('submit', (e) => {
    e.preventDefault();
    const q = $('#searchInput').value.trim();
    if (!q) return;
    runSearch(q);
  });

  // "Add to Library" buttons in search results (delegated)
  $('#searchResults').addEventListener('click', (e) => {
    const btn = e.target.closest('.add-btn');
    if (btn) {
      e.stopPropagation();
      openModal({ ...lastDocs[Number(btn.dataset.index)] }, 'add');
      return;
    }
    const result = e.target.closest('.result');
    if (result) openModal({ ...lastDocs[Number(result.dataset.index)] }, 'add');
  });
  $('#searchResults').addEventListener('keydown', (e) => {
    if (e.key !== 'Enter' && e.key !== ' ') return;
    const result = e.target.closest('.result');
    if (!result || e.target.closest('.add-btn')) return;
    e.preventDefault();
    openModal({ ...lastDocs[Number(result.dataset.index)] }, 'add');
  });

  // Library cards: click / keyboard to edit
  const grid = $('#libraryGrid');
  const openCard = (card) => {
    const book = library.find((b) => b.id === card.dataset.id);
    if (book) openModal(book, 'edit');
  };
  grid.addEventListener('click', (e) => {
    const card = e.target.closest('.card');
    if (card) openCard(card);
  });
  grid.addEventListener('keydown', (e) => {
    if (e.key !== 'Enter' && e.key !== ' ') return;
    const card = e.target.closest('.card');
    if (card) { e.preventDefault(); openCard(card); }
  });

  $('#fStatus').addEventListener('change', updateRatingVisibility);

  // Filters & sort
  $('#statusFilter').addEventListener('change', (e) => { statusFilter = e.target.value; renderLibrary(); });
  $('#librarySearch').addEventListener('input', (e) => { libraryQuery = e.target.value.trim(); renderLibrary(); });
  $('#sortBy').addEventListener('change', (e) => { sortBy = e.target.value; renderLibrary(); });

  // Silently clamp page inputs to each other (no browser validation popup)
  $('#fCurrentPage').addEventListener('input', (e) => {
    const total = Number($('#fPageCount').value) || Infinity;
    const val = Number(e.target.value);
    if (val > total) e.target.value = total;
  });
  $('#fPageCount').addEventListener('input', (e) => {
    const total = Number(e.target.value) || Infinity;
    const cp = $('#fCurrentPage');
    const val = Number(cp.value);
    if (total > 0 && val > total) cp.value = total;
  });
  $('#abandonQuestsBtn').addEventListener('click', abandonAllQuests);
  $('#resetProgressBtn').addEventListener('click', resetAllProgress);

  // Quest tabs
  document.querySelectorAll('.quest-tab').forEach((tab) => {
    tab.addEventListener('click', () => {
      document.querySelectorAll('.quest-tab').forEach((t) => {
        const active = t.dataset.questtab === tab.dataset.questtab;
        t.classList.toggle('active', active);
        t.setAttribute('aria-selected', String(active));
      });
      renderProgress();
    });
  });

  // Quest list: individual abandon (delegated)
  $('#questList').addEventListener('click', (e) => {
    const action = e.target.closest('.quest-action-btn');
    if (!action) return;
    abandonQuest(action.dataset.questId);
  });
  document.querySelectorAll('.view-toggle-btn').forEach((button) => {
    button.addEventListener('click', () => {
      libraryView = button.dataset.view;
      try { localStorage.setItem(LIBRARY_VIEW_KEY, libraryView); } catch { /* private mode */ }
      document.querySelectorAll('.view-toggle-btn').forEach((item) => {
        const active = item.dataset.view === libraryView;
        item.classList.toggle('active', active);
        item.setAttribute('aria-pressed', String(active));
      });
      renderLibrary();
    });
  });

  // Modal
  $('#bookForm').addEventListener('submit', (e) => { e.preventDefault(); saveFromModal(); });
  $('#cancelBtn').addEventListener('click', closeModal);
  $('#deleteBtn').addEventListener('click', deleteFromModal);
  $('#modalBackdrop').addEventListener('click', (e) => { if (e.target === e.currentTarget) closeModal(); });
  document.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape') return;
    if (calendarTarget) closeCalendar();
    else closeModal();
  });

  document.querySelectorAll('.date-display').forEach((input) => {
    input.addEventListener('click', () => {
      const target = input.id.replace('Display', '');
      if (calendarTarget === target) closeCalendar();
      else openCalendar(target);
    });
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') openCalendar(input.id.replace('Display', ''));
    });
  });
  $('#calendarPopover').addEventListener('click', (e) => {
    const day = e.target.closest('[data-date]');
    if (day) { chooseDate(day.dataset.date); return; }
    const action = e.target.closest('[data-calendar-action]')?.dataset.calendarAction;
    if (action === 'prev') calendarMonth = new Date(calendarMonth.getFullYear(), calendarMonth.getMonth() - 1, 1);
    if (action === 'next') calendarMonth = new Date(calendarMonth.getFullYear(), calendarMonth.getMonth() + 1, 1);
    if (action === 'today') chooseDate(dateValue(new Date()));
    if (action === 'clear') chooseDate('');
    if (action === 'prev' || action === 'next') {
      renderCalendar();
      positionCalendar();
    }
  });

  window.addEventListener('resize', positionCalendar);

  // Star rating widget. Click sets a permanent rating; hovering only previews.
  const stars = $('#ratingInput');
  stars.addEventListener('click', (e) => {
    const btn = e.target.closest('.star-btn');
    if (!btn) return;
    const v = Number(btn.dataset.star);
    modalRating = modalRating === v ? 0 : v;   // click same value again to clear
    renderRatingInput();
  });
  stars.addEventListener('mouseover', (e) => {
    const btn = e.target.closest('.star-btn');
    if (!btn) return;
    renderRatingInput(Number(btn.dataset.star));
  });
  stars.addEventListener('mouseleave', () => renderRatingInput()); // restore saved rating

  // Android hardware back button: close the open modal first, then exit the app.
  // Without this, back would quit the app while a modal is up.
  if (window.Capacitor && window.Capacitor.isNativePlatform() && window.Capacitor.Plugins?.App) {
    const App = window.Capacitor.Plugins.App;
    App.addListener('backButton', () => {
      const modalOpen = !$('#modalBackdrop').classList.contains('hidden');
      if (modalOpen) closeModal();
      else App.exitApp().catch(() => {});
    });
  }
}

/* ---------------- Init ---------------- */

(async function init() {
  bindEvents();
  bindThemeToggle();
  try {
    library = await dbGetAll();
  } catch (err) {
    console.error(err);
    toast('Could not open local storage');
  }
  refreshAll();
})();




