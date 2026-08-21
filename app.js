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
let activeReader = null;
const PROGRESS_KEY = 'shelf-progress';
const STREAK_KEY = 'shelf-streak';
const READING_GOALS_KEY = 'shelf-reading-goals';
const READING_LOG_KEY = 'shelf-reading-log';
const READER_SETTINGS_KEY = 'shelf-reader-settings';
const UPDATE_REPO = 'calinadrian/Shelf';
const { localDateKey, normalizeBook, updateStreak, isNewerVersion, validateBackup } = window.ShelfCore;

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

function loadReadingGoals() {
  try { return { dailyMinutes: 5, yearlyBooks: 3, ...JSON.parse(localStorage.getItem(READING_GOALS_KEY)) }; }
  catch { return { dailyMinutes: 5, yearlyBooks: 3 }; }
}

function loadReadingLog() {
  try { return JSON.parse(localStorage.getItem(READING_LOG_KEY)) || {}; }
  catch { return {}; }
}

function saveReadingLog(log) {
  try { localStorage.setItem(READING_LOG_KEY, JSON.stringify(log)); } catch { /* private mode */ }
}

function recordReadingTime(milliseconds) {
  if (!milliseconds || milliseconds < 1000) return;
  const log = loadReadingLog();
  const key = localDateKey(new Date());
  log[key] = Math.max(0, Number(log[key]) || 0) + milliseconds;
  saveReadingLog(log);
}

function renderReadingGoals() {
  const goals = loadReadingGoals();
  const todayMs = Number(loadReadingLog()[localDateKey(new Date())]) || 0;
  const todayMinutes = Math.floor(todayMs / 60000);
  const year = new Date().getFullYear();
  const books = library.filter((book) => book.status === 'read' && book.finishDate && new Date(`${book.finishDate}T00:00:00`).getFullYear() === year).length;
  $('#dailyGoalValue').textContent = String(todayMinutes);
  $('#yearGoalValue').textContent = String(books);
  $('#dailyGoalCopy').textContent = `${todayMinutes} of ${goals.dailyMinutes} minutes`;
  $('#yearGoalCopy').textContent = `${books} of ${goals.yearlyBooks} books`;
  $('#dailyGoalRing').style.setProperty('--goal-pct', `${Math.min(100, todayMinutes / goals.dailyMinutes * 100)}%`);
  $('#yearGoalRing').style.setProperty('--goal-pct', `${Math.min(100, books / goals.yearlyBooks * 100)}%`);
  $('#dailyGoalInput').value = goals.dailyMinutes;
  $('#yearGoalInput').value = goals.yearlyBooks;
  const dailyDone = todayMinutes >= goals.dailyMinutes;
  const yearlyDone = books >= goals.yearlyBooks;
  $('#goalEncouragement').textContent = dailyDone && yearlyDone
    ? 'Both goals reached — every page from here is a victory lap.'
    : dailyDone ? 'Daily goal complete. Your streak is safe for today.'
      : todayMinutes ? `${Math.max(1, goals.dailyMinutes - todayMinutes)} more minute${goals.dailyMinutes - todayMinutes === 1 ? '' : 's'} to reach today’s goal.`
        : 'Five quiet minutes is enough to keep the story moving.';
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
  const streak = updateStreak(loadStreak());
  saveStreak(streak);
  return streak;
}

function recordDailyRead() {
  const streak = updateStreak(loadStreak(), new Date(), true);
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

function dateKey(date = new Date()) { return localDateKey(date); }
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
  renderReadingGoals();

  // Render quest tabs
  const activeTab = document.querySelector('.quest-tab.active')?.dataset.questtab || 'active';
  $('#abandonQuestsBtn').classList.toggle('hidden', activeTab !== 'active');
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
          <p class="quest-description"><span class="quest-how">How to complete</span>${esc(quest.description || 'Make progress in your library.')}</p>
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

function cacheCoverInBackground(book) {
  if (!book.coverUrl || book.coverData) return;
  cacheCover(book).then(async () => {
    if (!book.coverData) return;
    await dbPut(book);
    const current = library.find((item) => item.id === book.id);
    if (current) {
      current.coverData = book.coverData;
      current.coverUrl = book.coverUrl;
      renderLibrary();
    }
  }).catch((error) => console.info('Cover caching unavailable', error));
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

async function checkForUpdate() {
  const btn = $('#updateBtn');
  if (btn.disabled) return;
  btn.disabled = true;
  btn.classList.add('checking');
  try {
    const nativeUpdater = window.Capacitor?.Plugins?.AppUpdater;
    let release;
    if (window.Capacitor?.isNativePlatform() && nativeUpdater?.getLatestRelease) {
      const latest = await nativeUpdater.getLatestRelease();
      release = {
        tag_name: latest.tagName,
        html_url: `https://github.com/${UPDATE_REPO}/releases/tag/${latest.tagName}`,
        assets: [{ name: latest.assetName, browser_download_url: latest.assetUrl, size: 0 }],
      };
    } else {
      const updateUrl = new URL(`https://api.github.com/repos/${UPDATE_REPO}/releases/latest`);
      updateUrl.searchParams.set('_', Date.now().toString());
      const response = await fetch(updateUrl);
      if (response.status === 404) throw new Error('No GitHub release has been published yet');
      if (!response.ok) throw new Error(`GitHub returned ${response.status}`);
      release = await response.json();
    }
    const apk = (release.assets || []).find((asset) => asset.name?.toLowerCase().endsWith('.apk'));
    if (!apk) throw new Error('The latest release does not contain an APK');

    let currentVersion = '1.0.0';
    const App = window.Capacitor?.Plugins?.App;
    if (window.Capacitor?.isNativePlatform() && App?.getInfo) {
      currentVersion = (await App.getInfo()).version || currentVersion;
    }
    if (!isNewerVersion(release.tag_name, currentVersion)) {
      toast(`Shelf ${currentVersion} is up to date`);
      return;
    }

    const size = apk.size ? ` (${(apk.size / 1048576).toFixed(1)} MB)` : '';
    if (!window.confirm(`Shelf ${release.tag_name} is available${size}. Download and install it?`)) return;
    if (window.Capacitor?.isNativePlatform() && nativeUpdater?.downloadAndInstall) {
      const result = await nativeUpdater.downloadAndInstall({ url: apk.browser_download_url, fileName: apk.name });
      toast(result.permissionRequired ? 'Allow installs for Shelf, then tap Update again' : 'Update downloading…');
    } else {
      window.open(release.html_url, '_blank', 'noopener');
    }
  } catch (err) {
    console.error('Update check failed', err);
    toast(err.message || 'Could not check for updates');
  } finally {
    btn.disabled = false;
    btn.classList.remove('checking');
  }
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
  if (statusFilter === 'imported') books = books.filter((b) => Boolean(b.fileData));
  else if (statusFilter) books = books.filter((b) => b.status === statusFilter);
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
          ${b.status && b.status !== 'want' ? `<div class="stars small">${b.rating ? starsMarkup(b.rating) : '<span class="muted">No rating</span>'}</div>` : ''}
          <span class="page-progress">${b.currentPage || 0}${b.pageCount ? ` / ${b.pageCount} pages` : ' pages'}</span>
          ${b.fileData ? `<button type="button" class="card-read" data-read-id="${esc(b.id)}" aria-label="Read ${esc(b.title)}" title="Open reader">Imported</button>` : ''}
        </div>
      </div>
    </article>`).join('');
}

function renderStats() {
  const readBooks = library.filter((b) => b.status === 'read');
  const pagesRead = library.reduce((sum, book) => sum + Math.max(0,
    book.status === 'read' && book.pageCount ? book.pageCount : (book.currentPage || 0)
  ), 0);
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
  $('#readBtn').classList.toggle('hidden', !book.fileData || mode !== 'edit');

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

/* ---------------- Local book import & reader ---------------- */

function bookFormat(file) {
  const extension = file.name.split('.').pop().toLowerCase();
  if (!['epub', 'mobi', 'pdf'].includes(extension)) throw new Error('Choose an EPUB, MOBI, or PDF file.');
  return extension;
}

function configurePdfJs() {
  const pdfjs = window.ShelfReaderLibs.pdfjs;
  // The bundled main-thread handler is used for file:// compatibility. Keep an
  // absolute source as a secondary path for normal hosted/Capacitor builds.
  pdfjs.GlobalWorkerOptions.workerSrc = new URL('pdf.worker.mjs', document.baseURI).href;
  return pdfjs;
}

async function dataUrlFromObjectUrl(url) {
  if (!url) return null;
  try {
    const blob = await fetch(url).then((response) => {
      if (!response.ok) throw new Error(`Image request returned ${response.status}`);
      return response.blob();
    });
    return await new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(reader.result);
      reader.onerror = reject;
      reader.readAsDataURL(blob);
    });
  } catch { return null; }
}

async function coverFromFirstBookSection(parsed) {
  try {
    const spine = parsed.getSpine().slice(0, 3);
    for (const section of spine) {
      const chapter = await parsed.loadChapter(section.id);
      if (!chapter?.html) continue;
      const doc = new DOMParser().parseFromString(chapter.html, 'text/html');
      const image = doc.querySelector('img[src], svg image, object[data]');
      const source = image?.getAttribute('src') || image?.getAttribute('href') || image?.getAttribute('xlink:href') || image?.getAttribute('data');
      const cover = await dataUrlFromObjectUrl(source);
      if (cover?.startsWith('data:image/')) return cover;
    }
  } catch (error) {
    console.info('Could not extract a cover from the first book section', error);
  }
  return null;
}

async function coverFromStoredEbook(book) {
  if (!['epub', 'mobi'].includes(book.fileFormat) || !book.fileData) return null;
  const init = book.fileFormat === 'epub' ? window.ShelfReaderLibs.initEpubFile : window.ShelfReaderLibs.initMobiFile;
  const file = new File([book.fileData], book.fileName || `book.${book.fileFormat}`, { type: book.fileData.type });
  let parsed = null;
  try {
    parsed = await init(file);
    return await coverFromFirstBookSection(parsed);
  } catch (error) {
    console.info('Stored ebook cover fallback unavailable', error);
    return null;
  } finally { parsed?.destroy(); }
}

function plainTextDescription(value) {
  const source = typeof value === 'object' && value ? value.value : value;
  if (!source) return '';
  const doc = new DOMParser().parseFromString(String(source).replace(/\\(?=<\/?[a-z])/gi, ''), 'text/html');
  doc.querySelectorAll('script,style,noscript').forEach((node) => node.remove());
  const blocks = new Set(['ADDRESS', 'ARTICLE', 'ASIDE', 'BLOCKQUOTE', 'DIV', 'FIGCAPTION', 'FOOTER', 'H1', 'H2', 'H3', 'H4', 'H5', 'H6', 'HEADER', 'LI', 'MAIN', 'NAV', 'P', 'SECTION', 'TR']);
  const read = (node) => {
    if (node.nodeType === Node.TEXT_NODE) return node.nodeValue || '';
    if (node.nodeName === 'BR') return '\n';
    const text = [...node.childNodes].map(read).join('');
    return blocks.has(node.nodeName) ? `${text}\n` : text;
  };
  return read(doc.body).replace(/[ \t]+/g, ' ').replace(/ *\n */g, '\n').replace(/\n{3,}/g, '\n\n').trim();
}

function isbnFrom(...values) {
  for (const value of values.flat(Infinity)) {
    const raw = typeof value === 'object' && value ? (value.identifier || value.id || '') : value;
    const match = String(raw || '').toUpperCase().match(/(?:97[89][\d -]{10,16}\d|[\d -]{9,14}[\dX])/);
    if (!match) continue;
    const isbn = match[0].replace(/[^\dX]/g, '');
    if (isbn.length === 10 || isbn.length === 13) return isbn;
  }
  return '';
}

async function fetchJsonWithTimeout(url, timeout = 12000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeout);
  try {
    const response = await fetch(url, { signal: controller.signal });
    if (!response.ok) throw new Error(`Metadata request returned ${response.status}`);
    return await response.json();
  } finally { clearTimeout(timer); }
}

function metadataSearchKey(value) {
  return String(value || '').normalize('NFKD').toLowerCase().replace(/[\u0300-\u036f]/g, '').replace(/[^a-z0-9]+/g, ' ').trim();
}

async function enrichFromGoogleBooks(details, title) {
  try {
    const query = details.isbn
      ? `isbn:${details.isbn}`
      : `intitle:"${title}"${details.author ? ` inauthor:"${details.author}"` : ''}`;
    const params = new URLSearchParams({ q: query, maxResults: '10', printType: 'books', projection: 'lite' });
    const result = await fetchJsonWithTimeout(`https://www.googleapis.com/books/v1/volumes?${params}`);
    const items = Array.isArray(result.items) ? result.items : [];
    const titleKey = metadataSearchKey(title);
    const authorKey = metadataSearchKey(details.author);
    const usable = items.filter((item) => item.volumeInfo?.imageLinks);
    const match = (details.isbn ? usable[0] : usable.find((item) => {
      const info = item.volumeInfo || {};
      const sameTitle = metadataSearchKey(info.title) === titleKey;
      const sameAuthor = !authorKey || (info.authors || []).some((author) => {
        const candidate = metadataSearchKey(author);
        return candidate === authorKey || candidate.includes(authorKey) || authorKey.includes(candidate);
      });
      return sameTitle && sameAuthor;
    })) || usable.find((item) => metadataSearchKey(item.volumeInfo?.title) === titleKey);
    if (!match) return details;

    const info = match.volumeInfo || {};
    const images = info.imageLinks || {};
    const image = images.extraLarge || images.large || images.medium || images.thumbnail || images.smallThumbnail;
    if (image) {
      details.coverUrl = String(image).replace(/^http:/, 'https:');
      details.coverProvider = 'google-books';
    }
    details.author ||= (info.authors || []).join(', ');
    details.isbn ||= isbnFrom((info.industryIdentifiers || []).map((item) => item.identifier));
    details.description ||= plainTextDescription(info.description);
  } catch (error) {
    console.info('Google Books cover lookup unavailable', error);
  }
  return details;
}

async function renderPdfFirstPageCover(pdf) {
  try {
    const page = await pdf.getPage(1);
    const base = page.getViewport({ scale: 1 });
    const scale = Math.min(2, 900 / base.width);
    const viewport = page.getViewport({ scale: Math.max(1, scale) });
    const canvas = document.createElement('canvas');
    canvas.width = Math.ceil(viewport.width);
    canvas.height = Math.ceil(viewport.height);
    const context = canvas.getContext('2d', { alpha: false });
    await page.render({ canvasContext: context, viewport, background: '#ffffff' }).promise;
    return canvas.toDataURL('image/jpeg', .88);
  } catch (error) {
    console.info('Could not create a cover from the first PDF page', error);
    return null;
  }
}

async function coverFromStoredPdf(book) {
  if (book.fileFormat !== 'pdf' || !book.fileData) return null;
  const pdfjs = configurePdfJs();
  let pdf = null;
  try {
    pdf = await pdfjs.getDocument({ data: new Uint8Array(await book.fileData.arrayBuffer()), verbosity: 0 }).promise;
    return await renderPdfFirstPageCover(pdf);
  } catch (error) {
    console.info('Stored PDF cover fallback unavailable', error);
    return null;
  } finally { await pdf?.destroy(); }
}

async function enrichImportedMetadata(details, fallbackTitle) {
  const title = details.title || fallbackTitle;
  if (!title || (details.coverData && details.author && details.isbn && details.description)) return details;
  try {
    const params = new URLSearchParams({ title, limit: '5', fields: 'key,title,author_name,isbn,cover_i,first_sentence' });
    if (details.author) params.set('author', details.author);
    const result = await fetchJsonWithTimeout(`https://openlibrary.org/search.json?${params}`);
    const titleKey = metadataSearchKey(title);
    const authorKey = metadataSearchKey(details.author);
    const docs = Array.isArray(result.docs) ? result.docs : [];
    const match = docs.find((doc) => {
      const sameTitle = metadataSearchKey(doc.title) === titleKey;
      const sameAuthor = !authorKey || (doc.author_name || []).some((author) => {
        const candidate = metadataSearchKey(author);
        return candidate === authorKey || candidate.includes(authorKey) || authorKey.includes(candidate);
      });
      return sameTitle && sameAuthor;
    }) || docs.find((doc) => metadataSearchKey(doc.title) === titleKey) || docs[0];
    if (!match) throw new Error('No Open Library match');

    details.author ||= (match.author_name || []).join(', ');
    details.isbn ||= isbnFrom(match.isbn || []);
    if (!details.coverData && match.cover_i) {
      details.coverUrl = coverUrlFor(match.cover_i, 'L');
      details.coverProvider = 'open-library';
    }
    if (!details.description) {
      const firstSentence = Array.isArray(match.first_sentence) ? match.first_sentence[0] : match.first_sentence;
      details.description = plainTextDescription(firstSentence);
      if (match.key) {
        const workPath = String(match.key).startsWith('/') ? match.key : `/works/${match.key}`;
        const work = await fetchJsonWithTimeout(`https://openlibrary.org${workPath}.json`);
        details.description = plainTextDescription(work.description) || details.description;
      }
    }
  } catch (error) {
    console.info('Open Library metadata lookup unavailable', error);
  }
  if (!details.coverData && !details.coverUrl) await enrichFromGoogleBooks(details, title);
  return details;
}

async function inspectLocalBook(file, format) {
  if (format === 'pdf') {
    const pdfjs = configurePdfJs();
    const pdf = await pdfjs.getDocument({ data: new Uint8Array(await file.arrayBuffer()), verbosity: 0 }).promise;
    const metadata = await pdf.getMetadata().catch(() => ({ info: {} }));
    const result = {
      title: metadata.info?.Title,
      author: metadata.info?.Author,
      pageCount: pdf.numPages,
      pdfFirstPageCover: await renderPdfFirstPageCover(pdf),
    };
    await pdf.destroy();
    return result;
  }
  const init = format === 'epub' ? window.ShelfReaderLibs.initEpubFile : window.ShelfReaderLibs.initMobiFile;
  const parsed = await init(file);
  const metadata = parsed.getMetadata() || {};
  const creators = metadata.creator || metadata.author || [];
  const author = Array.isArray(creators)
    ? creators.map((item) => typeof item === 'string' ? item : item.contributor).filter(Boolean).join(', ')
    : String(creators || '');
  let embeddedCoverUrl = '';
  try { embeddedCoverUrl = parsed.getCoverImage?.() || ''; } catch { /* cover is optional */ }
  const embeddedCover = await dataUrlFromObjectUrl(embeddedCoverUrl);
  const result = {
    title: metadata.title,
    author,
    isbn: isbnFrom(metadata.isbn, metadata.identifier, metadata.packageIdentifier),
    description: plainTextDescription(metadata.description),
    coverData: embeddedCover || await coverFromFirstBookSection(parsed),
    readerSections: parsed.getSpine().length,
  };
  parsed.destroy();
  return result;
}

async function importLocalBook(file) {
  const format = bookFormat(file);
  const fallbackTitle = file.name.replace(/\.[^.]+$/, '').replace(/[_-]+/g, ' ').trim();
  const details = await enrichImportedMetadata(await inspectLocalBook(file, format), fallbackTitle);
  if (!details.coverData && !details.coverUrl && details.pdfFirstPageCover) {
    details.coverData = details.pdfFirstPageCover;
    details.coverProvider = 'pdf-first-page';
  }
  const book = normalizeBook({
    id: newId(), title: details.title || fallbackTitle || 'Untitled', author: details.author || '',
    description: details.description || '', coverData: details.coverData || null, coverUrl: details.coverUrl || null,
    coverProvider: details.coverProvider || null,
    isbn: details.isbn || null,
    pageCount: details.pageCount || null, currentPage: 0, status: 'reading', rating: 0, notes: '', tags: [],
    addedAt: new Date().toISOString(), startDate: localDateKey(), finishDate: null,
    fileName: file.name, fileFormat: format, fileData: file.slice(0, file.size, file.type),
    readerPosition: 0, readerSections: details.readerSections || details.pageCount || 1,
    metadataLookupAt: Date.now(), metadataLookupVersion: 4,
  });
  await dbPut(book);
  createBookQuest(book);
  await reloadLibrary();
  cacheCoverInBackground(book);
  switchTab('library');
  toast(`Imported “${book.title}”`);
  await openReader(book);
}

async function repairImportedMetadata() {
  const retryAfter = 6 * 60 * 60 * 1000;
  const candidates = library.filter((book) => {
    if (!book.fileData) return false;
    const descriptionNeedsCleaning = /<\/?[a-z][\s\S]*>/i.test(book.description || '') || /&#(?:x[\da-f]+|\d+);/i.test(book.description || '');
    const questionableIsbnCover = !book.coverData && /covers\.openlibrary\.org\/b\/isbn\//i.test(book.coverUrl || '');
    const missingMetadata = (!book.coverData && !book.coverUrl) || questionableIsbnCover || !book.author || !book.isbn || !book.description;
    const lookupIsStale = book.metadataLookupVersion !== 4 || Date.now() - (book.metadataLookupAt || 0) >= retryAfter;
    return descriptionNeedsCleaning || (missingMetadata && lookupIsStale);
  });
  if (!candidates.length) return;

  let visibleChange = false;
  for (const book of candidates) {
    const before = [book.author, book.isbn, book.description, book.coverData, book.coverUrl].join('|');
    const questionableIsbnCover = !book.coverData && /covers\.openlibrary\.org\/b\/isbn\//i.test(book.coverUrl || '');
    const localSectionCover = !book.coverData && ['epub', 'mobi'].includes(book.fileFormat)
      ? await coverFromStoredEbook(book)
      : null;
    const details = await enrichImportedMetadata({
      title: book.title,
      author: book.author || '',
      isbn: book.isbn || '',
      description: plainTextDescription(book.description),
      coverData: localSectionCover || book.coverData || null,
      coverUrl: questionableIsbnCover ? null : (book.coverUrl || null),
      coverProvider: questionableIsbnCover ? null : (book.coverProvider || null),
    }, book.title);
    book.author = details.author || book.author || '';
    book.isbn = details.isbn || book.isbn || null;
    book.description = plainTextDescription(details.description || book.description);
    book.coverData = details.coverData || book.coverData || null;
    book.coverUrl = details.coverUrl || (questionableIsbnCover ? null : book.coverUrl) || null;
    book.coverProvider = details.coverProvider || (questionableIsbnCover ? null : book.coverProvider) || null;
    if (localSectionCover) book.coverProvider = 'embedded-first-section';
    if (!book.coverData && !book.coverUrl && book.fileFormat === 'pdf') {
      book.coverData = await coverFromStoredPdf(book);
      if (book.coverData) book.coverProvider = 'pdf-first-page';
    }
    book.metadataLookupAt = Date.now();
    book.metadataLookupVersion = 4;
    await dbPut(book);
    cacheCoverInBackground(book);
    visibleChange ||= before !== [book.author, book.isbn, book.description, book.coverData, book.coverUrl].join('|');
  }
  if (visibleChange) await reloadLibrary();
}

const DEFAULT_READER_SETTINGS = { theme: 'sepia', font: 'serif', fontSize: 18, lineHeight: 1.7, margins: 8, brightness: 100, align: 'left', mode: 'scroll', curl: true, eitherMargin: false };

function loadReaderSettings() {
  try { return { ...DEFAULT_READER_SETTINGS, ...JSON.parse(localStorage.getItem(READER_SETTINGS_KEY)) }; }
  catch { return { ...DEFAULT_READER_SETTINGS }; }
}

function saveReaderSettings(settings) {
  try { localStorage.setItem(READER_SETTINGS_KEY, JSON.stringify(settings)); } catch { /* private mode */ }
}

function readerDocument(html, css, settings) {
  const themes = {
    light: 'color:#211d16;background:#fffcf5',
    sepia: 'color:#382f24;background:#f4ecd8',
    dark: 'color:#ece3d0;background:#16130e',
  };
  const fonts = { serif: 'Georgia,serif', sans: 'Arial,sans-serif', dyslexic: 'Verdana,Tahoma,sans-serif' };
  const colors = themes[settings.theme] || themes.sepia;
  const pageMargin = Math.max(0, Number(settings.margins) || 0);
  const paged = settings.mode === 'page'
    ? `html{width:100vw!important;height:100vh!important;overflow-x:auto!important;overflow-y:hidden!important;scroll-behavior:smooth;scrollbar-width:none}html::-webkit-scrollbar{display:none}body{width:100vw!important;max-width:none!important;height:100vh!important;max-height:100vh!important;margin:0!important;padding:2rem ${pageMargin}vw!important;column-width:calc(100vw - ${pageMargin * 2}vw)!important;column-gap:${pageMargin * 2}vw!important;column-fill:auto;overflow:visible!important;box-sizing:border-box}img,svg{max-height:calc(100vh - 4rem);object-fit:contain}`
    : 'html{overflow-x:hidden;overflow-y:auto}';
  const darkOverrides = settings.theme === 'dark'
    ? 'html,body{color:#ddd6c9!important;background:#161513!important}body *{color:inherit!important}body :where(div,section,article,main,aside,header,footer,p,blockquote,pre,table,tbody,tr,td,th){background-color:transparent!important}a{color:#9bc7a4!important}mark.shelf-highlight{color:#201c16!important}'
    : '';
  const stylesheets = (css || []).map((item) => `<link rel="stylesheet" href="${esc(item.href)}">`).join('');
  return `<!doctype html><meta name="viewport" content="width=device-width,initial-scale=1">${stylesheets}<style>html{${colors};overscroll-behavior:contain;touch-action:pan-y;background:inherit}${paged}body{max-width:46rem;margin:0 auto;padding:2rem ${pageMargin}vw;font:${settings.fontSize}px/${settings.lineHeight} ${fonts[settings.font] || fonts.serif};text-align:${settings.align};color:inherit;background:inherit}img,svg{max-width:100%;height:auto}a{color:#3f7650}pre{white-space:pre-wrap}${darkOverrides}mark.shelf-highlight{color:inherit;background:#f2c94c99;border-radius:.15em;box-decoration-break:clone;-webkit-box-decoration-break:clone;cursor:pointer}mark.shelf-highlight[data-color="green"]{background:#66bd8399}mark.shelf-highlight[data-color="blue"]{background:#66a9dc99}mark.shelf-highlight[data-color="pink"]{background:#e989a399}mark.shelf-highlight[data-color="purple"]{background:#ad8ad599}mark.shelf-highlight[data-color="orange"]{background:#e99a4b99}mark.shelf-highlight.shelf-note{background:#7db7e58c;text-decoration:underline dotted;cursor:pointer}mark.shelf-highlight.shelf-focus{animation:shelf-focus 1.4s ease}@keyframes shelf-focus{0%,100%{outline:0 solid transparent}35%{outline:4px solid #3f765066}}</style>${html}`;
}

function applyReaderSettings({ rerender = true, restoreRatio = null } = {}) {
  if (!activeReader) return;
  const settings = activeReader.settings;
  const reader = $('#reader');
  reader.classList.toggle('reader-dark', settings.theme === 'dark');
  reader.classList.toggle('reader-sepia', settings.theme === 'sepia');
  $('#readerStage').style.filter = `brightness(${settings.brightness}%)`;
  $('#readerFont').value = settings.font;
  $('#readerFontSize').value = settings.fontSize;
  $('#readerLineHeight').value = settings.lineHeight;
  $('#readerMargins').value = settings.margins;
  $('#readerBrightness').value = settings.brightness;
  $('#readerCurl').checked = settings.curl;
  $('#readerEitherMargin').checked = settings.eitherMargin;
  document.querySelectorAll('[data-reader-theme]').forEach((button) => button.classList.toggle('active', button.dataset.readerTheme === settings.theme));
  document.querySelectorAll('[data-reader-align]').forEach((button) => button.classList.toggle('active', button.dataset.readerAlign === settings.align));
  document.querySelectorAll('[data-reader-mode]').forEach((button) => button.classList.toggle('active', button.dataset.readerMode === settings.mode));
  saveReaderSettings(settings);
  if (rerender && activeReader.parser) {
    if (restoreRatio != null) activeReader.pendingScrollRatio = Math.max(0, Math.min(1, restoreRatio));
    renderReaderPosition(activeReader.position, { preserveChrome: true });
  }
}

function setReaderChrome(hidden) {
  const reader = $('#reader');
  if (reader.classList.contains('reader-chrome-hidden') === hidden) return;
  const header = reader.querySelector('.reader-header');
  const controls = reader.querySelector('.reader-controls');
  reader.classList.toggle('reader-chrome-hidden', hidden);
  header.setAttribute('aria-hidden', String(hidden));
  controls.setAttribute('aria-hidden', String(hidden));
  header.inert = hidden;
  controls.inert = hidden;
  if (activeReader) activeReader.chromeHidden = hidden;
}

function handleReaderScroll(scrollTop) {
  if (!activeReader) return;
  const previous = activeReader.lastScrollTop ?? 0;
  activeReader.lastScrollTop = scrollTop;
  // Keep the reading viewport's geometry stable at the end of a chapter. The
  // chrome remains hidden after a real scroll and is restored only by a double
  // tap, so an overscroll bounce cannot repeatedly show/hide it.
  if (activeReader.chromeHidden) return;
  activeReader.scrollDistance = (activeReader.scrollDistance || 0) + Math.abs(scrollTop - previous);
  if (activeReader.scrollDistance > 4) setReaderChrome(true);
}

function bindReaderDoubleTap(target) {
  let lastTap = null;
  let lastTouchDoubleTap = 0;
  let pointerStart = null;
  target.addEventListener('pointerdown', (event) => {
    pointerStart = { id: event.pointerId, x: event.clientX, y: event.clientY };
  }, { passive: true });
  target.addEventListener('pointerup', (event) => {
    if (!activeReader || (event.pointerType && event.pointerType !== 'touch' && event.pointerType !== 'pen')) return;
    if (!pointerStart || pointerStart.id !== event.pointerId || Math.hypot(event.clientX - pointerStart.x, event.clientY - pointerStart.y) > 14) {
      pointerStart = null;
      lastTap = null;
      return;
    }
    pointerStart = null;
    const now = performance.now();
    const tap = { time: now, x: event.clientX, y: event.clientY };
    if (lastTap && now - lastTap.time < 360 && Math.hypot(tap.x - lastTap.x, tap.y - lastTap.y) < 32) {
      event.preventDefault();
      setReaderChrome(!activeReader.chromeHidden);
      lastTouchDoubleTap = now;
      lastTap = null;
    } else {
      lastTap = tap;
    }
  }, { passive: false });

  // Retain an equivalent gesture for mouse/trackpad testing on desktop.
  target.addEventListener('dblclick', (event) => {
    if (!activeReader || performance.now() - lastTouchDoubleTap < 500) return;
    event.preventDefault();
    setReaderChrome(!activeReader.chromeHidden);
  });
}

function bindReflowableSwipeNavigation(target) {
  let start = null;
  target.addEventListener('pointerdown', (event) => {
    if (!activeReader?.parser || (event.pointerType && event.pointerType !== 'touch' && event.pointerType !== 'pen')) return;
    const selection = target.getSelection?.();
    start = {
      x: event.clientX,
      y: event.clientY,
      time: performance.now(),
      pointerId: event.pointerId,
      hadSelection: Boolean(selection && !selection.isCollapsed),
    };
  }, { passive: true });
  target.addEventListener('pointerup', (event) => {
    if (!start || !activeReader?.parser || event.pointerId !== start.pointerId) { start = null; return; }
    const dx = event.clientX - start.x;
    const dy = event.clientY - start.y;
    const elapsed = performance.now() - start.time;
    const wasSelecting = start.hadSelection || readerSelectionInteractionActive(target);
    start = null;
    if (wasSelecting || elapsed > 700 || Math.abs(dx) < 55 || Math.abs(dx) < Math.abs(dy) * 1.25) return;
    event.preventDefault();
    navigateReader(dx < 0 ? 1 : -1);
  }, { passive: false });
  target.addEventListener('pointercancel', () => { start = null; }, { passive: true });
}

function bindPdfSwipeNavigation(target) {
  let start = null;
  target.addEventListener('pointerdown', (event) => {
    if (!activeReader?.pdf || (activeReader.zoom || 1) > 1.02 || activeReader.pinching || (event.pointerType && event.pointerType !== 'touch' && event.pointerType !== 'pen')) return;
    start = { x: event.clientX, y: event.clientY, time: performance.now(), pointerId: event.pointerId };
  }, { passive: true });
  target.addEventListener('pointerup', (event) => {
    if (!start || !activeReader?.pdf || activeReader.pinching || (activeReader.zoom || 1) > 1.02 || event.pointerId !== start.pointerId) { start = null; return; }
    const dx = event.clientX - start.x;
    const dy = event.clientY - start.y;
    const elapsed = performance.now() - start.time;
    start = null;
    if (elapsed > 700 || Math.abs(dx) < 55 || Math.abs(dx) < Math.abs(dy) * 1.25) return;
    event.preventDefault();
    navigateReader(dx < 0 ? 1 : -1);
  }, { passive: false });
  target.addEventListener('pointercancel', () => { start = null; }, { passive: true });
}

function bindPdfPinchZoom(target) {
  const pointers = new Map();
  let initialDistance = 0;
  let initialZoom = 1;
  let previewZoom = 1;

  const distance = () => {
    const [a, b] = [...pointers.values()];
    return a && b ? Math.hypot(b.x - a.x, b.y - a.y) : 0;
  };

  target.addEventListener('pointerdown', (event) => {
    if (!activeReader?.pdf || (event.pointerType && event.pointerType !== 'touch' && event.pointerType !== 'pen')) return;
    pointers.set(event.pointerId, { x: event.clientX, y: event.clientY });
    if (pointers.size === 2) {
      initialDistance = distance();
      initialZoom = activeReader.zoom || 1;
      previewZoom = initialZoom;
      activeReader.pinching = true;
    }
  }, { passive: true });

  target.addEventListener('pointermove', (event) => {
    if (!pointers.has(event.pointerId)) return;
    pointers.set(event.pointerId, { x: event.clientX, y: event.clientY });
    if (!activeReader?.pinching || pointers.size < 2 || !initialDistance) return;
    event.preventDefault();
    previewZoom = Math.max(1, Math.min(3, initialZoom * distance() / initialDistance));
    const canvas = $('#readerPdf');
    canvas.style.transform = `scale(${previewZoom / initialZoom})`;
  }, { passive: false });

  const finish = (event) => {
    pointers.delete(event.pointerId);
    if (!activeReader?.pinching || pointers.size >= 2) return;
    activeReader.pinching = false;
    activeReader.zoom = previewZoom;
    const canvas = $('#readerPdf');
    canvas.style.transform = '';
    renderPdfPage().catch((error) => console.error('PDF zoom failed', error));
  };
  target.addEventListener('pointerup', finish, { passive: true });
  target.addEventListener('pointercancel', finish, { passive: true });
}

function bindReflowableReaderGestures() {
  const frame = $('#readerPage');
  const doc = frame.contentDocument;
  if (!doc || !activeReader) return;
  activeReader.lastScrollTop = doc.scrollingElement?.scrollTop || 0;
  activeReader.scrollDistance = 0;
  applyStoredHighlights(doc);
  if (activeReader.pendingHighlightId) {
    const highlightId = activeReader.pendingHighlightId;
    activeReader.pendingHighlightId = null;
    requestAnimationFrame(() => {
      const mark = [...doc.querySelectorAll('[data-highlight-id]')].find((item) => item.dataset.highlightId === highlightId);
      if (!mark) return;
      mark.scrollIntoView({ block: 'center', inline: 'center' });
      mark.classList.add('shelf-focus');
    });
  }
  if (activeReader.pendingScrollRatio != null) {
    const ratio = activeReader.pendingScrollRatio;
    activeReader.pendingScrollRatio = null;
    const restore = () => {
      const root = doc.scrollingElement;
      if (root && activeReader?.settings.mode === 'page') {
        const target = ratio * Math.max(0, root.scrollWidth - root.clientWidth);
        root.scrollLeft = Math.round(target / Math.max(1, root.clientWidth)) * root.clientWidth;
      }
      else if (root) root.scrollTop = ratio * Math.max(0, root.scrollHeight - root.clientHeight);
    };
    requestAnimationFrame(restore);
    setTimeout(restore, 120);
  }
  let selectionPageLeft = null;
  const rememberSelectionPage = () => {
    if (activeReader?.settings.mode !== 'page') return;
    const root = doc.scrollingElement;
    if (!root) return;
    selectionPageLeft = Math.round(root.scrollLeft / Math.max(1, root.clientWidth)) * root.clientWidth;
  };
  doc.addEventListener('selectstart', rememberSelectionPage, { passive: true });
  doc.addEventListener('pointerdown', () => {
    if (readerSelectionIsActive(doc)) rememberSelectionPage();
  }, { passive: true });
  doc.addEventListener('scroll', () => {
    const root = doc.scrollingElement;
    if (selectionPageLeft != null && readerSelectionIsActive(doc) && activeReader?.settings.mode === 'page'
      && Math.abs(root.scrollLeft - selectionPageLeft) > 1) {
      root.scrollLeft = selectionPageLeft;
    }
    handleReaderScroll(root?.scrollTop || 0);
  }, { passive: true });
  bindReflowableSwipeNavigation(doc);
  doc.addEventListener('selectionchange', updateReaderSelectionActions);
  // Android WebView's native selection action bar duplicates Shelf's toolbar.
  // Prevent the web context menu as a fallback; the native wrapper also hides
  // its ActionMode while the reader is open, without disabling selection handles.
  doc.addEventListener('contextmenu', (event) => {
    if (readerSelectionIsActive(doc)) event.preventDefault();
  });
  doc.addEventListener('click', (event) => {
    const mark = event.target.closest?.('mark.shelf-highlight');
    if (mark && activeReader?.parser) {
      const id = mark.dataset.highlightId;
      const annotation = (activeReader.book.readerHighlights || []).find((item) => item.id === id);
      if (annotation?.note) toast(annotation.note);
      else {
        activeReader.book.readerHighlights = (activeReader.book.readerHighlights || []).filter((item) => item.id !== id);
        mark.replaceWith(...mark.childNodes);
        dbPut(activeReader.book).catch(() => {});
        renderReaderHighlights();
        toast('Highlight removed');
      }
      return;
    }
    if (readerSelectionInteractionActive(doc)) return;
    const width = doc.documentElement.clientWidth;
    const x = event.clientX;
    if (activeReader.settings.mode === 'page' && (x < width * .18 || x > width * .82)) {
      const direction = activeReader.settings.eitherMargin ? 1 : (x < width / 2 ? -1 : 1);
      navigateReader(direction);
    } else setReaderChrome(!activeReader.chromeHidden);
  });
}

function readerSelectionIsActive(doc = $('#readerPage').contentDocument) {
  const selection = doc?.getSelection?.();
  return Boolean(selection && !selection.isCollapsed && selection.toString().trim());
}

function readerSelectionInteractionActive(doc = $('#readerPage').contentDocument) {
  return readerSelectionIsActive(doc) || Boolean(activeReader?.selectionGuardUntil > performance.now());
}

function navigateReader(direction) {
  if (!activeReader) return;
  if (activeReader.parser && readerSelectionInteractionActive()) return;
  if (activeReader.parser && activeReader.settings.mode === 'page') {
    const root = $('#readerPage').contentDocument?.scrollingElement;
    if (root) {
      const step = root.clientWidth;
      const next = root.scrollLeft + direction * step;
      const max = Math.max(0, root.scrollWidth - root.clientWidth);
      if (next >= 0 && next <= max + 2 && Math.abs(next - root.scrollLeft) > 2) {
        root.scrollTo({ left: Math.max(0, Math.min(max, next)), behavior: activeReader.settings.curl ? 'smooth' : 'auto' });
        return;
      }
    }
  }
  const total = activeReader.pdf?.numPages || activeReader.parser.getSpine().length;
  const nextPosition = activeReader.position + direction;
  if (nextPosition < 0 || nextPosition >= total) return;
  renderReaderPosition(nextPosition, { preserveChrome: true });
}

function textOffset(body, node, offset) {
  const range = body.ownerDocument.createRange();
  range.selectNodeContents(body);
  range.setEnd(node, offset);
  return range.toString().length;
}

function rangeFromTextOffsets(doc, start, end) {
  const walker = doc.createTreeWalker(doc.body, NodeFilter.SHOW_TEXT);
  const range = doc.createRange();
  let node;
  let count = 0;
  let started = false;
  while ((node = walker.nextNode())) {
    const next = count + node.data.length;
    if (!started && start >= count && start <= next) {
      range.setStart(node, Math.min(node.data.length, start - count));
      started = true;
    }
    if (started && end >= count && end <= next) {
      range.setEnd(node, Math.min(node.data.length, end - count));
      return range;
    }
    count = next;
  }
  return null;
}

function wrapHighlightRange(range, id, kind = 'highlight', note = '', color = 'yellow') {
  const mark = range.startContainer.ownerDocument.createElement('mark');
  mark.className = `shelf-highlight${kind === 'note' ? ' shelf-note' : ''}`;
  mark.dataset.highlightId = id;
  mark.dataset.color = color;
  mark.title = note || 'Tap to remove highlight';
  mark.append(range.extractContents());
  range.insertNode(mark);
}

function applyStoredHighlights(doc) {
  const highlights = (activeReader?.book?.readerHighlights || [])
    .filter((item) => item.position === activeReader.position)
    .sort((a, b) => b.start - a.start);
  highlights.forEach((item) => {
    const range = rangeFromTextOffsets(doc, item.start, item.end);
    if (range && !range.collapsed) wrapHighlightRange(range, item.id, item.kind, item.note, item.color);
  });
}

function updateReaderHighlightButton() {
  const button = $('#readerHighlight');
  const selection = activeReader?.parser ? $('#readerPage').contentWindow?.getSelection() : null;
  button.disabled = !selection || selection.isCollapsed || !selection.toString().trim();
}

function hideReaderSelectionMenu() {
  $('#readerSelectionMenu').classList.add('hidden');
  if (activeReader) activeReader.selectedRange = null;
}

function setNativeReaderSelectionMenuSuppressed(suppressed) {
  const plugin = window.Capacitor?.Plugins?.ReaderSelection;
  if (!window.Capacitor?.isNativePlatform?.() || !plugin?.setSuppressed) return;
  plugin.setSuppressed({ suppressed }).catch((error) => console.warn('Could not configure native selection menu', error));
}

function updateReaderSelectionActions() {
  updateReaderHighlightButton();
  const menu = $('#readerSelectionMenu');
  const selection = activeReader?.parser ? $('#readerPage').contentWindow?.getSelection() : null;
  if (!selection || selection.isCollapsed || !selection.toString().trim() || !selection.rangeCount) {
    if (activeReader?.selectedRange) activeReader.selectionGuardUntil = performance.now() + 450;
    menu.classList.add('hidden');
    return;
  }
  const range = selection.getRangeAt(0);
  activeReader.selectedRange = range.cloneRange();
  activeReader.selectedText = selection.toString().trim();
  const rect = range.getBoundingClientRect();
  menu.classList.remove('hidden');
  menu.style.left = `${Math.max(8, Math.min(window.innerWidth - menu.offsetWidth - 8, rect.left))}px`;
  menu.style.top = `${Math.max(54, rect.top - 8)}px`;
}

function selectedReaderRange() {
  if (!activeReader?.parser) return null;
  const live = $('#readerPage').contentWindow?.getSelection();
  if (live?.rangeCount && !live.isCollapsed) return live.getRangeAt(0);
  return activeReader.selectedRange || null;
}

function createReaderAnnotation(kind, note = '', color = 'yellow') {
  const doc = $('#readerPage').contentDocument;
  const range = selectedReaderRange();
  if (!doc?.body || !range || !doc.body.contains(range.commonAncestorContainer)) return false;
  const annotation = {
    id: newId(), kind, note, color,
    position: activeReader.position,
    start: textOffset(doc.body, range.startContainer, range.startOffset),
    end: textOffset(doc.body, range.endContainer, range.endOffset),
    text: range.toString().trim().slice(0, 300),
    createdAt: new Date().toISOString(),
  };
  if (annotation.end <= annotation.start) return false;
  activeReader.book.readerHighlights = [...(activeReader.book.readerHighlights || []), annotation];
  wrapHighlightRange(range, annotation.id, kind, note, color);
  $('#readerPage').contentWindow?.getSelection()?.removeAllRanges();
  dbPut(activeReader.book).catch(() => {});
  renderReaderHighlights();
  hideReaderSelectionMenu();
  return true;
}

function saveReaderHighlight(color = 'yellow') {
  if (createReaderAnnotation('highlight', '', color)) toast('Text highlighted');
}

async function handleReaderSelectionAction(action) {
  const text = activeReader?.selectedText || selectedReaderRange()?.toString().trim();
  if (!text) return;
  if (action.startsWith('highlight-')) saveReaderHighlight(action.slice(10));
  else if (action === 'note') {
    const note = window.prompt('Add a note for this passage:');
    if (note?.trim() && createReaderAnnotation('note', note.trim())) toast('Note saved');
  } else if (action === 'define') {
    const word = text.trim().split(/\s+/)[0].replace(/[^\p{L}'-]/gu, '');
    try {
      const response = await fetch(`https://api.dictionaryapi.dev/api/v2/entries/en/${encodeURIComponent(word)}`);
      if (!response.ok) throw new Error('Definition unavailable');
      const data = await response.json();
      const meaning = data[0]?.meanings?.[0];
      const definition = meaning?.definitions?.[0]?.definition;
      if (!definition) throw new Error('Definition unavailable');
      window.alert(`${word}${meaning.partOfSpeech ? ` · ${meaning.partOfSpeech}` : ''}\n\n${definition}`);
    } catch { toast(`No definition found for “${word}”`); }
    hideReaderSelectionMenu();
  } else if (action === 'translate') {
    const language = (navigator.language || 'en').split('-')[0];
    window.open(`https://translate.google.com/?sl=auto&tl=${encodeURIComponent(language)}&text=${encodeURIComponent(text)}&op=translate`, '_blank', 'noopener');
    hideReaderSelectionMenu();
  } else if (action === 'copy') {
    await navigator.clipboard.writeText(text);
    hideReaderSelectionMenu();
    toast('Copied');
  } else if (action === 'share') {
    if (navigator.share) await navigator.share({ text });
    else { await navigator.clipboard.writeText(text); toast('Copied for sharing'); }
    hideReaderSelectionMenu();
  }
}

function closeReaderSheets() {
  $('#readerNavSheet').classList.add('hidden');
  $('#readerDisplaySheet').classList.add('hidden');
  $('#reader').classList.remove('sheet-open');
}

function openReaderSheet(id) {
  const sheet = $(`#${id}`);
  const opening = sheet.classList.contains('hidden');
  closeReaderSheets();
  if (!opening) return;
  sheet.classList.remove('hidden');
  $('#reader').classList.add('sheet-open');
  setReaderChrome(false);
  if (id === 'readerNavSheet') {
    renderReaderToc();
    renderReaderHighlights();
    renderReaderBookmarks();
  } else applyReaderSettings({ rerender: false });
}

function flattenToc(items, depth = 0, result = []) {
  (items || []).forEach((item) => {
    result.push({ ...item, depth });
    flattenToc(item.children, depth + 1, result);
  });
  return result;
}

function tocPosition(item) {
  if (!activeReader?.parser) return 0;
  const spine = activeReader.parser.getSpine();
  let resolved;
  try { resolved = activeReader.parser.resolveHref?.(item.href); } catch { /* malformed book link */ }
  const id = resolved?.id || item.id || item.href;
  const index = spine.findIndex((section) => section.id === id || String(item.href || '').includes(section.id));
  return Math.max(0, index);
}

function renderReaderToc() {
  if (!activeReader) return;
  const toc = activeReader.parser ? flattenToc(activeReader.parser.getToc?.() || []) : [];
  const total = activeReader.pdf?.numPages || 0;
  const entries = toc.length ? toc.map((item) => ({ label: item.label || 'Untitled section', position: tocPosition(item), depth: item.depth }))
    : Array.from({ length: total || activeReader.parser?.getSpine().length || 0 }, (_, index) => ({ label: activeReader.pdf ? `Page ${index + 1}` : `Section ${index + 1}`, position: index, depth: 0 }));
  $('#readerToc').innerHTML = entries.map((item) => `<li class="${item.position === activeReader.position ? 'active' : ''}" style="padding-left:${item.depth * 14}px"><button type="button" data-reader-position="${item.position}">${esc(item.label)}<small>${activeReader.pdf ? 'Page' : 'Section'} ${item.position + 1}</small></button></li>`).join('') || '<li><button type="button" disabled>No contents available</button></li>';
}

function readerScrollRatio(mode = activeReader?.settings.mode) {
  if (!activeReader?.parser) return 0;
  const root = $('#readerPage').contentDocument?.scrollingElement;
  if (!root) return 0;
  const horizontal = mode === 'page';
  const range = horizontal ? root.scrollWidth - root.clientWidth : root.scrollHeight - root.clientHeight;
  return range > 0 ? (horizontal ? root.scrollLeft : root.scrollTop) / range : 0;
}

function currentReaderScrollRatio() {
  return readerScrollRatio();
}

function rememberReaderSpot() {
  if (!activeReader) return;
  activeReader.returnSpot = { position: activeReader.position, scrollRatio: currentReaderScrollRatio() };
  $('#readerReturn').classList.remove('hidden');
}

function jumpToReaderPosition(position, scrollRatio = 0) {
  if (!activeReader) return;
  rememberReaderSpot();
  activeReader.pendingScrollRatio = Math.max(0, Math.min(1, Number(scrollRatio) || 0));
  closeReaderSheets();
  renderReaderPosition(position, { preserveChrome: true });
}

function renderReaderBookmarks() {
  if (!activeReader) return;
  const bookmarks = activeReader.book.readerBookmarks || [];
  $('#readerBookmarks').innerHTML = bookmarks.length ? bookmarks.slice().reverse().map((item) => `<li><button type="button" data-bookmark-id="${esc(item.id)}">${esc(item.label || `${activeReader.pdf ? 'Page' : 'Section'} ${item.position + 1}`)}<small>${new Date(item.createdAt).toLocaleDateString()}</small></button></li>`).join('') : '<li><button type="button" disabled>No bookmarks yet</button></li>';
}

function renderReaderHighlights() {
  if (!activeReader) return;
  const highlights = (activeReader.book.readerHighlights || []).slice().reverse();
  $('#readerHighlights').innerHTML = highlights.length ? highlights.map((item) => {
    const color = ['yellow', 'green', 'blue', 'pink', 'purple', 'orange'].includes(item.color) ? item.color : 'yellow';
    const location = `${activeReader.pdf ? 'Page' : 'Section'} ${item.position + 1}`;
    return `<li><button type="button" data-highlight-jump="${esc(item.id)}"><span class="reader-highlight-row"><span class="highlight-dot ${color}" aria-hidden="true"></span><span><span class="reader-highlight-text">${esc(item.text || 'Highlighted passage')}</span>${item.note ? `<span class="reader-highlight-note">${esc(item.note)}</span>` : ''}<small>${location} · ${new Date(item.createdAt).toLocaleDateString()}</small></span></span></button></li>`;
  }).join('') : '<li><button type="button" disabled>No highlights yet</button></li>';
}

function jumpToReaderHighlight(id) {
  const item = (activeReader?.book.readerHighlights || []).find((highlight) => highlight.id === id);
  if (!item) return;
  rememberReaderSpot();
  activeReader.pendingHighlightId = item.id;
  closeReaderSheets();
  renderReaderPosition(item.position, { preserveChrome: true });
}

async function searchReader(query) {
  if (!activeReader || !query) return;
  const status = $('#readerSearchStatus');
  const results = [];
  const total = activeReader.pdf?.numPages || activeReader.parser.getSpine().length;
  status.textContent = `Searching ${total} ${activeReader.pdf ? 'pages' : 'sections'}…`;
  $('#readerSearchResults').innerHTML = '';
  for (let index = 0; index < total; index += 1) {
    let text = '';
    if (activeReader.pdf) {
      const page = await activeReader.pdf.getPage(index + 1);
      text = (await page.getTextContent()).items.map((item) => item.str).join(' ');
    } else {
      const chapter = await activeReader.parser.loadChapter(activeReader.parser.getSpine()[index].id);
      text = new DOMParser().parseFromString(chapter?.html || '', 'text/html').body.textContent || '';
    }
    const offset = text.toLocaleLowerCase().indexOf(query.toLocaleLowerCase());
    if (offset >= 0) results.push({ position: index, snippet: text.slice(Math.max(0, offset - 55), offset + query.length + 90).replace(/\s+/g, ' ').trim() });
    if (index % 5 === 0) status.textContent = `Searching… ${index + 1} of ${total}`;
  }
  status.textContent = results.length ? `${results.length} result${results.length === 1 ? '' : 's'}` : 'No matches found';
  $('#readerSearchResults').innerHTML = results.map((item) => `<li><button type="button" data-reader-position="${item.position}">${esc(item.snippet)}<small>${activeReader.pdf ? 'Page' : 'Section'} ${item.position + 1}</small></button></li>`).join('');
}

function updateReaderBookmarkButton() {
  const button = $('#readerBookmark');
  const bookmarks = activeReader?.book?.readerBookmarks || [];
  const bookmark = bookmarks.find((item) => item.position === activeReader?.position);
  const available = Boolean(activeReader);
  button.classList.toggle('hidden', !available);
  button.classList.toggle('has-bookmark', Boolean(bookmark));
  button.textContent = bookmark ? '♥' : '♡';
  const label = bookmark ? 'Remove bookmark' : 'Save bookmark';
  button.setAttribute('aria-label', label);
  button.title = label;
  $('#readerHighlight').classList.toggle('hidden', !available);
  $('#readerHighlight').disabled = true;
}

function saveOrOpenReaderBookmark() {
  if (!activeReader) return;
  const { book } = activeReader;
  book.readerBookmarks ||= book.readerBookmark ? [{ id: newId(), ...book.readerBookmark, label: 'Saved spot' }] : [];
  const bookmark = book.readerBookmarks.find((item) => item.position === activeReader.position);
  if (bookmark) {
    book.readerBookmarks = book.readerBookmarks.filter((item) => item.id !== bookmark.id);
    toast('Bookmark removed');
  } else {
    book.readerBookmarks.push({ id: newId(), position: activeReader.position, scrollRatio: currentReaderScrollRatio(), label: `${activeReader.pdf ? 'Page' : 'Section'} ${activeReader.position + 1}`, createdAt: new Date().toISOString() });
    toast('Bookmark saved');
  }
  dbPut(book).catch(() => {});
  updateReaderBookmarkButton();
  renderReaderBookmarks();
}

async function renderPdfPage() {
  const reader = activeReader;
  if (!reader?.pdf) return;
  const renderId = (reader.pdfRenderId || 0) + 1;
  reader.pdfRenderId = renderId;
  reader.pdfRenderTask?.cancel();

  const page = await reader.pdf.getPage(reader.position + 1);
  if (activeReader !== reader || reader.pdfRenderId !== renderId) return;
  const canvas = $('#readerPdf');
  const base = page.getViewport({ scale: 1 });
  const stage = $('#readerStage');
  const availableWidth = Math.max(280, stage.clientWidth);
  const availableHeight = Math.max(280, stage.clientHeight);
  const fitScale = Math.max(.25, Math.min(2, availableWidth / base.width, availableHeight / base.height));
  const displayScale = fitScale * Math.max(1, Math.min(3, reader.zoom || 1));
  const viewport = page.getViewport({ scale: displayScale });
  $('#reader').classList.toggle('reader-pdf-zoomed', (reader.zoom || 1) > 1.02);

  // Render physical device pixels into the backing canvas while preserving its
  // CSS size. This is the PDF.js high-DPI pattern and prevents browser upscaling.
  // Supersample at least 2× even on desktop DPR-1 displays; high-density
  // phones can use up to 3×. PDF vectors and text therefore remain crisp when
  // the browser composites or slightly zooms the page.
  const outputScale = Math.max(2, Math.min(3, window.devicePixelRatio || 1));
  canvas.width = Math.ceil(viewport.width * outputScale);
  canvas.height = Math.ceil(viewport.height * outputScale);
  canvas.style.width = `${Math.round(viewport.width)}px`;
  canvas.style.height = `${Math.round(viewport.height)}px`;
  const transform = outputScale === 1 ? null : [outputScale, 0, 0, outputScale, 0, 0];
  const context = canvas.getContext('2d', { alpha: false });
  reader.pdfRenderTask = page.render({ canvasContext: context, transform, viewport, background: '#ffffff' });
  try { await reader.pdfRenderTask.promise; }
  catch (error) {
    if (error?.name !== 'RenderingCancelledException') throw error;
    return;
  }
  if (activeReader === reader && reader.pdfRenderId === renderId) canvas.classList.remove('hidden');
}

async function renderReaderPosition(position, { preserveChrome = false } = {}) {
  if (!activeReader) return;
  const { book, parser, pdf } = activeReader;
  const total = pdf ? pdf.numPages : parser.getSpine().length;
  activeReader.position = Math.max(0, Math.min(Number(position) || 0, total - 1));
  if (activeReader.readingStartedAt) recordReadingTime(Date.now() - activeReader.readingStartedAt);
  activeReader.readingStartedAt = Date.now();
  hideReaderSelectionMenu();
  activeReader.lastScrollTop = 0;
  activeReader.scrollDistance = 0;
  if (!preserveChrome) setReaderChrome(false);
  $('#readerStage').scrollTop = 0;
  $('#readerLoading').classList.remove('hidden');
  $('#readerPage').classList.add('hidden');
  $('#readerPdf').classList.add('hidden');
  if (pdf) {
    await renderPdfPage();
  } else {
    const spine = parser.getSpine();
    const chapter = await parser.loadChapter(spine[activeReader.position].id);
    $('#readerPage').srcdoc = readerDocument(chapter?.html || '<p>This section is empty.</p>', chapter?.css, activeReader.settings);
    $('#readerPage').classList.remove('hidden');
  }
  $('#readerLoading').classList.add('hidden');
  $('#readerPosition').textContent = `${activeReader.position + 1} of ${total}`;
  $('#readerProgress').max = total; $('#readerProgress').value = activeReader.position + 1;
  const internalPages = Boolean(parser && activeReader.settings.mode === 'page');
  $('#readerPrev').disabled = !internalPages && activeReader.position === 0;
  $('#readerNext').disabled = !internalPages && activeReader.position === total - 1;
  updateReaderBookmarkButton();
  renderReaderToc();
  book.readerPosition = activeReader.position;
  const previousPages = Math.max(0, book.currentPage || 0);
  const positionPages = pdf
    ? activeReader.position + 1
    : (book.pageCount
      ? Math.max(1, Math.round(((activeReader.position + 1) / total) * book.pageCount))
      : activeReader.position + 1);
  book.currentPage = Math.max(previousPages, positionPages);
  if (book.currentPage > previousPages) recordDailyRead();
  dbPut(book).catch(() => {});
  if (activeReader.settings.curl) {
    $('#reader').classList.remove('reader-curl-out');
    requestAnimationFrame(() => $('#reader').classList.add('reader-curl-out'));
  }
}

async function openReader(book) {
  closeModal();
  const file = new File([book.fileData], book.fileName || `book.${book.fileFormat}`, { type: book.fileData.type });
  $('#reader').classList.remove('hidden'); document.body.style.overflow = 'hidden';
  $('#readerTitle').textContent = book.title; $('#readerLoading').classList.remove('hidden');
  try {
    if (book.fileFormat === 'pdf') {
      const pdfjs = configurePdfJs();
      const pdf = await pdfjs.getDocument({ data: new Uint8Array(await file.arrayBuffer()), verbosity: 0 }).promise;
      activeReader = { book, pdf, parser: null, position: book.readerPosition || 0, settings: loadReaderSettings(), lastScrollTop: 0, chromeHidden: false, zoom: 1, pinching: false, readingStartedAt: Date.now() };
    } else {
      const init = book.fileFormat === 'epub' ? window.ShelfReaderLibs.initEpubFile : window.ShelfReaderLibs.initMobiFile;
      const parser = await init(file);
      activeReader = { book, parser, pdf: null, position: book.readerPosition || 0, settings: loadReaderSettings(), lastScrollTop: 0, chromeHidden: false, readingStartedAt: Date.now() };
    }
    setNativeReaderSelectionMenuSuppressed(Boolean(activeReader.parser));
    $('#reader').classList.toggle('reader-pdf-mode', Boolean(activeReader.pdf));
    applyReaderSettings({ rerender: false });
    updateReaderBookmarkButton();
    await renderReaderPosition(activeReader.position);
  } catch (error) {
    console.error('Reader failed', error); closeReader(); toast('This book could not be opened.');
  }
}

function closeReader() {
  if (!activeReader && $('#reader').classList.contains('hidden')) return;
  if (activeReader?.readingStartedAt) recordReadingTime(Date.now() - activeReader.readingStartedAt);
  activeReader?.pdfRenderTask?.cancel();
  activeReader?.parser?.destroy(); activeReader?.pdf?.destroy(); activeReader = null;
  $('#reader').classList.add('hidden');
  $('#reader').classList.remove('reader-chrome-hidden');
  $('#reader').classList.remove('reader-pdf-mode');
  $('#reader').classList.remove('reader-pdf-zoomed');
  $('#reader').classList.remove('reader-sepia');
  $('#reader').classList.remove('reader-dark');
  $('#reader').classList.remove('reader-curl-out');
  closeReaderSheets();
  $('#readerReturn').classList.add('hidden');
  $('#readerBookmark').classList.add('hidden');
  $('#readerHighlight').classList.add('hidden');
  $('#readerPage').srcdoc = ''; document.body.style.overflow = '';
  setNativeReaderSelectionMenuSuppressed(false);
  hideReaderSelectionMenu();
  reloadLibrary().catch(() => {});
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
  let book = { ...modalBook };
  book.id = modalBook.id || newId();
  book.status = $('#fStatus').value;
  book.rating = modalRating;
  book.notes = $('#fNotes').value.trim();
  book.tags = [];
  book.currentPage = Math.max(0, Number($('#fCurrentPage').value) || 0);
  const pageCount = Number($('#fPageCount').value);
  book.pageCount = pageCount > 0 ? pageCount : null;
  book.startDate = $('#fStart').value || null;
  book.finishDate = $('#fFinish').value || null;
  if (!book.addedAt) book.addedAt = new Date().toISOString();
  book = normalizeBook(book);

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

function backupPayload() {
  return {
    format: 'shelf-backup',
    version: 1,
    exportedAt: new Date().toISOString(),
    // Binary ebook files stay in IndexedDB; JSON backups keep the library metadata only.
    books: library.map(({ fileData, ...book }) => book),
    progress: loadProgress(),
    streak: loadStreak(),
  };
}

function exportBackup() {
  const blob = new Blob([JSON.stringify(backupPayload(), null, 2)], { type: 'application/json' });
  const link = document.createElement('a');
  link.href = URL.createObjectURL(blob);
  link.download = `shelf-backup-${dateKey()}.json`;
  link.click();
  setTimeout(() => URL.revokeObjectURL(link.href), 0);
  toast('Backup exported');
}

async function importBackup(file) {
  const parsed = validateBackup(JSON.parse(await file.text()));
  if (!window.confirm(`Replace your current library with ${parsed.books.length} book${parsed.books.length === 1 ? '' : 's'} from this backup?`)) return;
  const db = await openDB();
  await new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, 'readwrite');
    const store = tx.objectStore(STORE_NAME);
    store.clear();
    parsed.books.forEach((book) => store.put(book));
    tx.oncomplete = resolve;
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error || new Error('Import was aborted'));
  });
  saveProgress(parsed.progress);
  saveStreak(parsed.streak);
  await reloadLibrary();
  toast(`Imported ${parsed.books.length} book${parsed.books.length === 1 ? '' : 's'}`);
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
  $('#updateBtn').addEventListener('click', checkForUpdate);

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
    const read = e.target.closest('[data-read-id]');
    if (read) {
      e.stopPropagation();
      const book = library.find((item) => item.id === read.dataset.readId);
      if (book) openReader(book);
      return;
    }
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
  $('#exportBtn').addEventListener('click', exportBackup);
  $('#importBtn').addEventListener('click', () => $('#importFile').click());
  $('#importFile').addEventListener('change', async (e) => {
    const [file] = e.target.files;
    e.target.value = '';
    if (!file) return;
    try { await importBackup(file); }
    catch (err) { console.error('Import failed', err); toast(err.message || 'Could not import backup'); }
  });
  $('#bookImportBtn').addEventListener('click', () => $('#bookImportFile').click());
  $('#bookImportFile').addEventListener('change', async (e) => {
    const [file] = e.target.files; e.target.value = '';
    if (!file) return;
    $('#bookImportBtn').disabled = true; $('#bookImportBtn').textContent = 'Importing…';
    try { await importLocalBook(file); }
    catch (err) { console.error('Book import failed', err); toast(err.message || 'Could not import this book'); }
    finally { $('#bookImportBtn').disabled = false; $('#bookImportBtn').textContent = 'Import book'; }
  });

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
  $('#editGoalsBtn').addEventListener('click', () => $('#goalEditor').classList.toggle('hidden'));
  $('#goalEditor').addEventListener('submit', (event) => {
    event.preventDefault();
    const goals = { dailyMinutes: Math.max(1, Number($('#dailyGoalInput').value) || 5), yearlyBooks: Math.max(1, Number($('#yearGoalInput').value) || 3) };
    try { localStorage.setItem(READING_GOALS_KEY, JSON.stringify(goals)); } catch { /* private mode */ }
    $('#goalEditor').classList.add('hidden');
    renderReadingGoals();
    toast('Reading goals updated');
  });

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
  $('#readBtn').addEventListener('click', () => { if (modalBook?.fileData) openReader(modalBook); });
  $('#modalBackdrop').addEventListener('click', (e) => { if (e.target === e.currentTarget) closeModal(); });
  document.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape') return;
    if (!$('#reader').classList.contains('hidden')) closeReader();
    else if (calendarTarget) closeCalendar();
    else closeModal();
  });
  $('#readerClose').addEventListener('click', closeReader);
  $('#readerNavigate').addEventListener('click', () => openReaderSheet('readerNavSheet'));
  $('#readerTheme').addEventListener('click', () => openReaderSheet('readerDisplaySheet'));
  $('#readerDimmer').addEventListener('click', closeReaderSheets);
  document.querySelectorAll('[data-close-sheet]').forEach((button) => button.addEventListener('click', closeReaderSheets));
  document.querySelectorAll('[data-reader-tab]').forEach((button) => button.addEventListener('click', () => {
    document.querySelectorAll('[data-reader-tab]').forEach((item) => item.classList.toggle('active', item === button));
    document.querySelectorAll('[data-reader-pane]').forEach((pane) => pane.classList.toggle('active', pane.dataset.readerPane === button.dataset.readerTab));
    if (button.dataset.readerTab === 'search') setTimeout(() => $('#readerSearchInput').focus(), 50);
  }));
  $('#readerNavSheet').addEventListener('click', (event) => {
    const positionButton = event.target.closest('[data-reader-position]');
    if (positionButton) jumpToReaderPosition(Number(positionButton.dataset.readerPosition));
    const bookmarkButton = event.target.closest('[data-bookmark-id]');
    if (bookmarkButton) {
      const item = (activeReader?.book.readerBookmarks || []).find((bookmark) => bookmark.id === bookmarkButton.dataset.bookmarkId);
      if (item) jumpToReaderPosition(item.position, item.scrollRatio);
    }
    const highlightButton = event.target.closest('[data-highlight-jump]');
    if (highlightButton) jumpToReaderHighlight(highlightButton.dataset.highlightJump);
  });
  $('#readerSearchForm').addEventListener('submit', (event) => {
    event.preventDefault();
    searchReader($('#readerSearchInput').value.trim()).catch((error) => { console.error(error); $('#readerSearchStatus').textContent = 'Search could not be completed'; });
  });
  const changeReaderSetting = (key, value, { reflow = true } = {}) => {
    if (!activeReader) return;
    const restoreRatio = activeReader.parser && reflow ? readerScrollRatio(activeReader.settings.mode) : null;
    activeReader.settings[key] = value;
    applyReaderSettings({ rerender: reflow, restoreRatio });
  };
  document.querySelectorAll('[data-reader-theme]').forEach((button) => button.addEventListener('click', () => changeReaderSetting('theme', button.dataset.readerTheme)));
  document.querySelectorAll('[data-reader-align]').forEach((button) => button.addEventListener('click', () => changeReaderSetting('align', button.dataset.readerAlign)));
  document.querySelectorAll('[data-reader-mode]').forEach((button) => button.addEventListener('click', () => changeReaderSetting('mode', button.dataset.readerMode)));
  $('#readerFont').addEventListener('change', (event) => changeReaderSetting('font', event.target.value));
  $('#readerFontSize').addEventListener('change', (event) => changeReaderSetting('fontSize', Number(event.target.value)));
  $('#readerLineHeight').addEventListener('change', (event) => changeReaderSetting('lineHeight', Number(event.target.value)));
  $('#readerMargins').addEventListener('change', (event) => changeReaderSetting('margins', Number(event.target.value)));
  $('#readerBrightness').addEventListener('input', (event) => {
    if (!activeReader) return;
    activeReader.settings.brightness = Number(event.target.value);
    applyReaderSettings({ rerender: false });
  });
  $('#readerCurl').addEventListener('change', (event) => changeReaderSetting('curl', event.target.checked, { reflow: false }));
  $('#readerEitherMargin').addEventListener('change', (event) => changeReaderSetting('eitherMargin', event.target.checked, { reflow: false }));
  $('#readerBookmark').addEventListener('click', saveOrOpenReaderBookmark);
  $('#readerHighlight').addEventListener('mousedown', (event) => event.preventDefault());
  $('#readerHighlight').addEventListener('click', () => saveReaderHighlight());
  $('#readerSelectionMenu').addEventListener('pointerdown', (event) => event.preventDefault());
  $('#readerSelectionMenu').addEventListener('click', (event) => {
    const action = event.target.closest('[data-selection-action]')?.dataset.selectionAction;
    if (action) handleReaderSelectionAction(action).catch((error) => {
      console.error('Selection action failed', error);
      toast('That action is not available');
    });
  });
  $('#readerPage').addEventListener('load', bindReflowableReaderGestures);
  $('#readerStage').addEventListener('scroll', (e) => {
    if (activeReader?.pdf) handleReaderScroll(e.currentTarget.scrollTop);
  }, { passive: true });
  bindPdfSwipeNavigation($('#readerStage'));
  bindPdfPinchZoom($('#readerStage'));
  $('#readerStage').addEventListener('click', (event) => {
    if (!activeReader?.pdf || event.target !== $('#readerPdf')) return;
    const rect = $('#readerStage').getBoundingClientRect();
    const x = event.clientX - rect.left;
    if (activeReader.settings.mode === 'page' && (x < rect.width * .18 || x > rect.width * .82)) navigateReader(activeReader.settings.eitherMargin ? 1 : (x < rect.width / 2 ? -1 : 1));
    else setReaderChrome(!activeReader.chromeHidden);
  });
  $('#readerPrev').addEventListener('click', () => navigateReader(-1));
  $('#readerNext').addEventListener('click', () => navigateReader(1));
  $('#readerProgress').addEventListener('change', (e) => renderReaderPosition(Number(e.target.value) - 1));
  $('#readerReturn').addEventListener('click', () => {
    if (!activeReader?.returnSpot) return;
    const current = { position: activeReader.position, scrollRatio: currentReaderScrollRatio() };
    const spot = activeReader.returnSpot;
    activeReader.returnSpot = current;
    activeReader.pendingScrollRatio = spot.scrollRatio;
    renderReaderPosition(spot.position, { preserveChrome: true });
  });
  let tocDrag = null;
  $('#readerToc').addEventListener('pointerdown', (event) => { tocDrag = { x: event.clientX, position: activeReader?.position || 0 }; });
  $('#readerToc').addEventListener('pointermove', (event) => {
    if (!tocDrag || !activeReader || Math.abs(event.clientX - tocDrag.x) < 24) return;
    event.preventDefault();
    const total = activeReader.pdf?.numPages || activeReader.parser.getSpine().length;
    const delta = Math.round((event.clientX - tocDrag.x) / Math.max(80, $('#readerToc').clientWidth) * total);
    const position = Math.max(0, Math.min(total - 1, tocDrag.position + delta));
    $('#readerPosition').textContent = `${position + 1} of ${total}`;
    tocDrag.preview = position;
  });
  const finishTocDrag = () => { if (tocDrag?.preview != null) jumpToReaderPosition(tocDrag.preview); tocDrag = null; };
  $('#readerToc').addEventListener('pointerup', finishTocDrag);
  $('#readerToc').addEventListener('pointercancel', () => { tocDrag = null; });

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

  let readerResizeTimer = null;
  window.addEventListener('resize', () => {
    positionCalendar();
    if (!activeReader) return;
    clearTimeout(readerResizeTimer);
    readerResizeTimer = setTimeout(() => {
      if (activeReader?.pdf) renderPdfPage().catch((error) => {
        if (error?.name !== 'RenderingCancelledException') console.error('PDF resize render failed', error);
      });
      else if (activeReader?.parser && activeReader.settings.mode === 'page') {
        renderReaderPosition(activeReader.position, { preserveChrome: true }).catch((error) => console.error('Reader resize render failed', error));
      }
    }, 140);
  });

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
      const readerOpen = !$('#reader').classList.contains('hidden');
      const modalOpen = !$('#modalBackdrop').classList.contains('hidden');
      if (readerOpen) closeReader();
      else if (modalOpen) closeModal();
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
  repairImportedMetadata().catch((error) => console.info('Imported metadata repair unavailable', error));
})();
