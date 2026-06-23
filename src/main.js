import ePub from "epubjs";
import pdfWorkerUrl from "pdfjs-dist/build/pdf.worker.min.mjs?url";
import "./styles.css";

const STORAGE_KEY = "polka-reader-state-v1";
const DB_NAME = "polka-reader-files";
const DB_STORE = "books";

const sampleText = [
  "Было уже поздно, когда город наконец затих. В окнах напротив один за другим гас свет, а в комнате оставался только мягкий круг от лампы и шелест переворачиваемых страниц.",
  "Книга всегда оказывалась чуть больше самой истории. Между строк сохранялись дни, в которые её читали, шум дождя за стеклом и случайные мысли, которые потом невозможно было отделить от текста.",
  "Он остановился у окна. Внизу медленно проехал последний трамвай, рассыпая свет по мокрым рельсам. Казалось, ещё одна глава — и станет понятно то, что ускользало весь вечер.",
  "Но ясность редко приходит по расписанию. Иногда нужно закрыть книгу, пройтись по тёмной комнате и только потом заметить, что ответ уже давно был рядом.",
  "На полях лежали короткие заметки прежнего читателя. Они спорили с автором, соглашались с ним и иногда уходили далеко в сторону. Этот тихий разговор через годы делал старый том почти живым.",
  "За стеной кто-то включил воду. Дом напомнил о себе скрипом труб и шагами на лестнице. Мир продолжал двигаться, пока рассказ удерживал время внутри нескольких страниц.",
  "В следующей главе всё начиналось заново: другой город, другое утро, незнакомое имя. И всё же сквозь новые декорации проступала та же мысль — человек узнаёт себя только в движении.",
  "Он улыбнулся и перевернул страницу. До рассвета оставалось ещё достаточно времени."
];

const seedBooks = [
  {
    id: "fahrenheit-451", title: "451° по Фаренгейту", author: "Рэй Брэдбери", format: "EPUB", progress: 38,
    color: "#e76f43", textColor: "#17201d", style: "type", decoration: "451", pages: 256, lastRead: Date.now() - 1000 * 60 * 18,
    favorite: true, sample: true
  },
  {
    id: "solaris", title: "Солярис", author: "Станислав Лем", format: "FB2", progress: 12,
    color: "#d5e7ad", textColor: "#23483f", style: "orbit", decoration: "", pages: 288, lastRead: Date.now() - 1000 * 60 * 60 * 28,
    favorite: false, sample: true
  },
  {
    id: "master", title: "Мастер и Маргарита", author: "Михаил Булгаков", format: "EPUB", progress: 0,
    color: "#283c5b", textColor: "#f7e8d1", style: "sun", decoration: "", pages: 416, lastRead: 0,
    favorite: true, sample: true
  },
  {
    id: "flowers", title: "Цветы для Элджернона", author: "Дэниел Киз", format: "PDF", progress: 67,
    color: "#efc65e", textColor: "#2c332d", style: "lines", decoration: "", pages: 320, lastRead: Date.now() - 1000 * 60 * 60 * 50,
    favorite: false, sample: true
  }
];

const icons = {
  library: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M4 19.5A2.5 2.5 0 0 1 6.5 17H20"/><path d="M6.5 2H20v20H6.5A2.5 2.5 0 0 1 4 19.5v-15A2.5 2.5 0 0 1 6.5 2Z"/></svg>',
  heart: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M20.8 4.6a5.5 5.5 0 0 0-7.8 0L12 5.7l-1.1-1.1a5.5 5.5 0 0 0-7.8 7.8l1.1 1.1L12 21l7.8-7.5 1.1-1.1a5.5 5.5 0 0 0-.1-7.8Z"/></svg>',
  upload: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4M17 8l-5-5-5 5M12 3v12"/></svg>',
  search: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><circle cx="11" cy="11" r="8"/><path d="m21 21-4.35-4.35"/></svg>',
  plus: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 5v14M5 12h14"/></svg>',
  chevron: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="m9 18 6-6-6-6"/></svg>',
  back: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path d="m15 18-6-6 6-6"/></svg>',
  close: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M18 6 6 18M6 6l12 12"/></svg>',
  check: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="m20 6-11 11-5-5"/></svg>',
  cloud: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7"><path d="M17.5 19H9a7 7 0 1 1 6.7-9h1.8a4.5 4.5 0 1 1 0 9Z"/><path d="m9 13 3-3 3 3M12 10v6"/></svg>',
  info: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><circle cx="12" cy="12" r="9"/><path d="M12 11v5M12 8h.01"/></svg>',
  arrowLeft: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path d="m15 18-6-6 6-6"/></svg>',
  arrowRight: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path d="m9 18 6-6-6-6"/></svg>',
  settings: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.9l.1.1-2.8 2.8-.1-.1a1.7 1.7 0 0 0-1.9-.3 1.7 1.7 0 0 0-1 1.6v.2h-4V21a1.7 1.7 0 0 0-1-1.6 1.7 1.7 0 0 0-1.9.3l-.1.1L4.2 17l.1-.1a1.7 1.7 0 0 0 .3-1.9A1.7 1.7 0 0 0 3 14H2.8v-4H3a1.7 1.7 0 0 0 1.6-1 1.7 1.7 0 0 0-.3-1.9L4.2 7 7 4.2l.1.1A1.7 1.7 0 0 0 9 4.6a1.7 1.7 0 0 0 1-1.6v-.2h4V3a1.7 1.7 0 0 0 1 1.6 1.7 1.7 0 0 0 1.9-.3l.1-.1L19.8 7l-.1.1a1.7 1.7 0 0 0-.3 1.9 1.7 1.7 0 0 0 1.6 1h.2v4H21a1.7 1.7 0 0 0-1.6 1Z"/></svg>'
};

let state = loadState();
let currentView = "library";
let activeFilter = "all";
let searchQuery = "";
let rendition = null;
let activeBook = null;
let pdfDocument = null;
let pdfRenderTask = null;
let pdfResizeTimer = null;
let pdfjs = null;
let scrollSaveTimer = null;

function loadState() {
  try {
    const saved = JSON.parse(localStorage.getItem(STORAGE_KEY));
    const savedById = new Map((saved?.books || []).map(book => [book.id, book]));
    return {
      books: [
        ...seedBooks.map(book => ({ ...book, ...(savedById.get(book.id) || {}) })),
        ...(saved?.books || []).filter(book => !seedBooks.some(seed => seed.id === book.id))
      ],
      profile: saved?.profile || { name: "Анна Крылова", email: "anna@example.ru" },
      readerTheme: saved?.readerTheme || "paper",
      readerSize: saved?.readerSize || 19
    };
  } catch {
    return { books: [...seedBooks], profile: { name: "Анна Крылова", email: "anna@example.ru" }, readerTheme: "paper", readerSize: 19 };
  }
}

function saveState() {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
}

function initials(name) {
  return name.split(/\s+/).filter(Boolean).slice(0, 2).map(part => part[0]).join("").toUpperCase() || "ЧТ";
}

function escapeHtml(value = "") {
  return String(value).replace(/[&<>"]/g, char => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[char]);
}

function timeGreeting() {
  const hour = new Date().getHours();
  if (hour < 6) return "Доброй ночи";
  if (hour < 12) return "Доброе утро";
  if (hour < 18) return "Добрый день";
  return "Добрый вечер";
}

function renderApp() {
  const visibleBooks = getVisibleBooks();
  const latest = [...state.books].filter(book => book.progress > 0).sort((a, b) => b.lastRead - a.lastRead)[0] || state.books[0];
  const firstName = state.profile.name.split(" ")[0] || "читатель";
  document.querySelector("#app").innerHTML = `
    <div class="shell">
      <aside class="sidebar">
        <div class="brand"><span class="brand-mark"></span><span>Полка</span></div>
        <nav class="main-nav" aria-label="Основная навигация">
          <span class="nav-label">Моя коллекция</span>
          ${navButton("library", "library", "Библиотека", state.books.length)}
          ${navButton("favorites", "heart", "Избранное", state.books.filter(book => book.favorite).length)}
          ${navButton("uploads", "upload", "Мои загрузки", state.books.filter(book => !book.sample).length)}
        </nav>
        <div class="sidebar-bottom">
          <div class="sync-card">
            <div class="sync-icon">${icons.cloud}</div>
            <strong>Книги всегда рядом</strong>
            <p>Интерфейс адаптируется под телефон, планшет и компьютер.</p>
          </div>
        </div>
      </aside>

      <div class="content">
        <header class="topbar">
          <label class="search" aria-label="Поиск книг">
            ${icons.search}
            <input id="searchInput" type="search" placeholder="Найти книгу или автора" value="${escapeHtml(searchQuery)}" />
          </label>
          <button class="account-button" id="accountButton" aria-label="Открыть профиль">
            <span class="avatar">${initials(state.profile.name)}</span>
            <span class="account-copy"><strong>${escapeHtml(state.profile.name)}</strong><span class="sync-status">Сохранено локально</span></span>
            ${icons.chevron}
          </button>
        </header>

        <main class="main">
          <div class="page-heading">
            <div><p class="eyebrow">${viewEyebrow()}</p><h1>${viewHeading(firstName)}</h1></div>
            <button class="primary-button" id="addBookButton">${icons.plus}<span class="button-label">Добавить книгу</span></button>
          </div>

          ${currentView === "library" && !searchQuery && latest ? continueMarkup(latest) : ""}

          <section class="library-section">
            <div class="section-heading">
              <h2>${sectionHeading()}</h2>
              <div class="filter-tabs" role="tablist">
                ${filterButton("all", "Все")}
                ${filterButton("reading", "Читаю")}
                ${filterButton("new", "Новые")}
              </div>
            </div>
            <div class="book-grid" id="bookGrid">
              ${visibleBooks.length ? visibleBooks.map(bookCardMarkup).join("") : emptyStateMarkup()}
            </div>
          </section>
        </main>
      </div>
    </div>

    <nav class="mobile-nav" aria-label="Мобильная навигация">
      ${mobileNavButton("library", "library", "Книги")}
      ${mobileNavButton("favorites", "heart", "Избранное")}
      <button id="mobileAdd">${icons.plus}<span>Добавить</span></button>
      <button id="mobileProfile"><span class="avatar">${initials(state.profile.name)}</span><span>Профиль</span></button>
    </nav>
    <div id="overlayRoot"></div>
  `;
  bindAppEvents();
}

function navButton(view, icon, label, count) {
  return `<button class="nav-item ${currentView === view ? "active" : ""}" data-view="${view}">${icons[icon]}<span>${label}</span><span class="nav-count">${count}</span></button>`;
}

function mobileNavButton(view, icon, label) {
  return `<button class="${currentView === view ? "active" : ""}" data-view="${view}">${icons[icon]}<span>${label}</span></button>`;
}

function viewEyebrow() {
  if (currentView === "favorites") return "Сохранённое";
  if (currentView === "uploads") return "Личные файлы";
  return "Моя библиотека";
}

function viewHeading(firstName) {
  if (searchQuery) return "Результаты поиска";
  if (currentView === "favorites") return "Избранное";
  if (currentView === "uploads") return "Мои загрузки";
  return `${timeGreeting()}, ${escapeHtml(firstName)}`;
}

function sectionHeading() {
  if (searchQuery) return `Найдено: ${getVisibleBooks().length}`;
  if (currentView === "favorites") return "Любимые книги";
  if (currentView === "uploads") return "Загруженные файлы";
  return "Все книги";
}

function filterButton(filter, label) {
  return `<button class="filter-tab ${activeFilter === filter ? "active" : ""}" data-filter="${filter}">${label}</button>`;
}

function continueMarkup(book) {
  return `
    <section class="continue-card" aria-label="Продолжить чтение">
      <div class="mini-cover" style="background:${book.color};color:${book.textColor}">
        <div class="cover-title">${escapeHtml(book.title)}</div><div class="cover-art">${book.decoration || "◯"}</div>
      </div>
      <div class="continue-info">
        <p class="eyebrow">Продолжить чтение</p>
        <h2>${escapeHtml(book.title)}</h2>
        <p class="book-author">${escapeHtml(book.author)}</p>
        <div class="progress-row"><div class="progress-track"><div class="progress-fill" style="width:${book.progress}%"></div></div><span class="progress-value">${Math.round(book.progress)}%</span></div>
      </div>
      <div class="continue-action">
        <button class="primary-button light" data-open-book="${book.id}">Читать дальше ${icons.chevron}</button>
        <span class="last-read">${relativeTime(book.lastRead)}</span>
      </div>
    </section>`;
}

function relativeTime(timestamp) {
  if (!timestamp) return "Ещё не открывали";
  const minutes = Math.floor((Date.now() - timestamp) / 60000);
  if (minutes < 1) return "Только что";
  if (minutes < 60) return `${minutes} мин. назад`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} ч. назад`;
  const days = Math.floor(hours / 24);
  return `${days} дн. назад`;
}

function getVisibleBooks() {
  return state.books.filter(book => {
    if (currentView === "favorites" && !book.favorite) return false;
    if (currentView === "uploads" && book.sample) return false;
    if (activeFilter === "reading" && !(book.progress > 0 && book.progress < 100)) return false;
    if (activeFilter === "new" && book.progress !== 0) return false;
    if (searchQuery && !`${book.title} ${book.author}`.toLowerCase().includes(searchQuery.toLowerCase())) return false;
    return true;
  });
}

function bookCardMarkup(book) {
  return `
    <article class="book-card" data-open-book="${book.id}">
      <div class="cover-shell">
        <div class="book-cover style-${book.style || "type"}" style="background:${book.color};color:${book.textColor}">
          <span class="cover-kicker">${book.format} · Полка</span>
          <div class="cover-title">${escapeHtml(book.title)}</div>
          <span class="cover-decoration">${escapeHtml(book.decoration || "")}</span>
          <span class="cover-author">${escapeHtml(book.author)}</span>
          <span class="format-badge">${book.format}</span>
        </div>
        <button class="favorite-button ${book.favorite ? "active" : ""}" data-favorite="${book.id}" aria-label="${book.favorite ? "Убрать из избранного" : "Добавить в избранное"}">${icons.heart}</button>
      </div>
      <div class="book-meta">
        <h3>${escapeHtml(book.title)}</h3>
        <p>${escapeHtml(book.author)} · ${book.pages ? `${book.pages} стр.` : book.format}</p>
        ${book.progress ? `<div class="card-progress"><div class="progress-track"><div class="progress-fill" style="width:${book.progress}%"></div></div><span>${Math.round(book.progress)}%</span></div>` : ""}
      </div>
    </article>`;
}

function emptyStateMarkup() {
  const text = searchQuery ? "Попробуйте изменить запрос" : currentView === "uploads" ? "Добавьте PDF, EPUB или FB2 с устройства" : "Здесь пока ничего нет";
  return `<div class="empty-state">${icons.library}<h3>${searchQuery ? "Ничего не найдено" : "Пока пусто"}</h3><p>${text}</p></div>`;
}

function bindAppEvents() {
  document.querySelectorAll("[data-view]").forEach(button => button.addEventListener("click", () => {
    currentView = button.dataset.view;
    activeFilter = "all";
    renderApp();
  }));
  document.querySelectorAll("[data-filter]").forEach(button => button.addEventListener("click", () => {
    activeFilter = button.dataset.filter;
    renderApp();
  }));
  document.querySelectorAll("[data-open-book]").forEach(element => element.addEventListener("click", event => {
    if (event.target.closest("[data-favorite]")) return;
    openReader(element.dataset.openBook);
  }));
  document.querySelectorAll("[data-favorite]").forEach(button => button.addEventListener("click", event => {
    event.stopPropagation();
    const book = state.books.find(item => item.id === button.dataset.favorite);
    book.favorite = !book.favorite;
    saveState();
    renderApp();
    showToast(book.favorite ? "Добавлено в избранное" : "Удалено из избранного");
  }));
  document.querySelector("#addBookButton")?.addEventListener("click", showUploadModal);
  document.querySelector("#mobileAdd")?.addEventListener("click", showUploadModal);
  document.querySelector("#accountButton")?.addEventListener("click", showAccountModal);
  document.querySelector("#mobileProfile")?.addEventListener("click", showAccountModal);
  document.querySelector("#searchInput")?.addEventListener("input", event => {
    searchQuery = event.target.value.trim();
    updateBookResults();
  });
}

function updateBookResults() {
  const grid = document.querySelector("#bookGrid");
  const heading = document.querySelector(".section-heading h2");
  const books = getVisibleBooks();
  if (heading) heading.textContent = `Найдено: ${books.length}`;
  if (grid) grid.innerHTML = books.length ? books.map(bookCardMarkup).join("") : emptyStateMarkup();
  document.querySelectorAll("[data-open-book]").forEach(element => element.addEventListener("click", event => {
    if (!event.target.closest("[data-favorite]")) openReader(element.dataset.openBook);
  }));
  document.querySelectorAll("[data-favorite]").forEach(button => button.addEventListener("click", event => {
    event.stopPropagation();
    const book = state.books.find(item => item.id === button.dataset.favorite);
    book.favorite = !book.favorite;
    saveState();
    updateBookResults();
  }));
}

function showUploadModal() {
  const root = document.querySelector("#overlayRoot");
  root.innerHTML = `
    <div class="modal-backdrop" role="dialog" aria-modal="true" aria-labelledby="uploadTitle">
      <div class="modal wide">
        <button class="close-button" aria-label="Закрыть">${icons.close}</button>
        <p class="eyebrow">Новая книга</p>
        <h2 id="uploadTitle">Добавить на полку</h2>
        <p class="modal-intro">Файл сохранится в браузере. Вы сможете вернуться к нужному месту после перезапуска.</p>
        <label class="drop-zone" id="dropZone">
          <input id="fileInput" type="file" accept=".pdf,.epub,.fb2,application/pdf,application/epub+zip" hidden />
          <span class="upload-icon">${icons.upload}</span>
          <strong>Перетащите книгу сюда</strong>
          <p>или нажмите, чтобы выбрать файл</p>
          <span class="format-list"><span>PDF</span><span>EPUB</span><span>FB2</span></span>
        </label>
        <div class="upload-progress" id="uploadProgress"><p><span id="uploadName">Загрузка…</span><span id="uploadPercent">0%</span></p><div class="progress-track"><div class="progress-fill" id="uploadBar"></div></div></div>
      </div>
    </div>`;
  const backdrop = root.querySelector(".modal-backdrop");
  const close = () => { root.innerHTML = ""; };
  root.querySelector(".close-button").addEventListener("click", close);
  backdrop.addEventListener("click", event => { if (event.target === backdrop) close(); });
  const zone = root.querySelector("#dropZone");
  const input = root.querySelector("#fileInput");
  input.addEventListener("change", () => input.files[0] && processFile(input.files[0]));
  ["dragenter", "dragover"].forEach(type => zone.addEventListener(type, event => { event.preventDefault(); zone.classList.add("dragover"); }));
  ["dragleave", "drop"].forEach(type => zone.addEventListener(type, event => { event.preventDefault(); zone.classList.remove("dragover"); }));
  zone.addEventListener("drop", event => event.dataTransfer.files[0] && processFile(event.dataTransfer.files[0]));
}

async function processFile(file) {
  const extension = file.name.split(".").pop()?.toLowerCase();
  if (!["pdf", "epub", "fb2"].includes(extension)) {
    showToast("Поддерживаются только PDF, EPUB и FB2");
    return;
  }
  const progress = document.querySelector("#uploadProgress");
  const bar = document.querySelector("#uploadBar");
  const percent = document.querySelector("#uploadPercent");
  const name = document.querySelector("#uploadName");
  progress?.classList.add("visible");
  if (name) name.textContent = file.name;
  if (bar) bar.style.width = "24%";
  if (percent) percent.textContent = "24%";

  try {
    let metadata = { title: file.name.replace(/\.[^.]+$/, ""), author: "Неизвестный автор" };
    let fb2Content = null;
    if (extension === "fb2") {
      const text = await file.text();
      ({ metadata, content: fb2Content } = parseFb2(text, metadata));
    } else if (extension === "epub") {
      try {
        const book = ePub(await file.arrayBuffer());
        const epubMeta = await book.loaded.metadata;
        metadata = { title: epubMeta.title || metadata.title, author: epubMeta.creator || metadata.author };
        book.destroy();
      } catch { /* Filename is a safe fallback. */ }
    }
    if (bar) bar.style.width = "68%";
    if (percent) percent.textContent = "68%";
    const id = `book-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
    await putBookFile(id, file, fb2Content);
    state.books.unshift({
      id, title: metadata.title, author: metadata.author, format: extension.toUpperCase(), progress: 0,
      color: coverColor(id), textColor: "#f8f3e7", style: ["type", "sun", "orbit", "lines"][state.books.length % 4],
      decoration: extension === "pdf" ? "P" : extension === "epub" ? "E" : "F", pages: null, lastRead: 0, favorite: false, sample: false
    });
    saveState();
    if (bar) bar.style.width = "100%";
    if (percent) percent.textContent = "100%";
    setTimeout(() => { renderApp(); showToast(`«${metadata.title}» добавлена на полку`); }, 350);
  } catch (error) {
    console.error(error);
    showToast("Не удалось прочитать файл");
  }
}

function parseFb2(text, fallback) {
  const doc = new DOMParser().parseFromString(text, "application/xml");
  if (doc.querySelector("parsererror")) return { metadata: fallback, content: [] };
  const title = doc.querySelector("description title-info book-title")?.textContent?.trim() || fallback.title;
  const first = doc.querySelector("description title-info author first-name")?.textContent?.trim() || "";
  const last = doc.querySelector("description title-info author last-name")?.textContent?.trim() || "";
  const author = `${first} ${last}`.trim() || fallback.author;
  const content = [...doc.querySelectorAll("body section p")].map(node => node.textContent.trim()).filter(Boolean);
  return { metadata: { title, author }, content };
}

function coverColor(id) {
  const palette = ["#925b54", "#315c69", "#676449", "#684d74", "#3e6657", "#9b7148"];
  return palette[[...id].reduce((sum, char) => sum + char.charCodeAt(0), 0) % palette.length];
}

function openDatabase() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, 1);
    request.onupgradeneeded = () => request.result.createObjectStore(DB_STORE, { keyPath: "id" });
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

async function putBookFile(id, file, content) {
  const db = await openDatabase();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(DB_STORE, "readwrite");
    tx.objectStore(DB_STORE).put({ id, file, content });
    tx.oncomplete = resolve;
    tx.onerror = () => reject(tx.error);
  });
}

async function getBookFile(id) {
  const db = await openDatabase();
  return new Promise((resolve, reject) => {
    const request = db.transaction(DB_STORE).objectStore(DB_STORE).get(id);
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

function showAccountModal() {
  const root = document.querySelector("#overlayRoot");
  root.innerHTML = `
    <div class="modal-backdrop" role="dialog" aria-modal="true" aria-labelledby="profileTitle">
      <form class="modal" id="profileForm">
        <button class="close-button" type="button" aria-label="Закрыть">${icons.close}</button>
        <p class="eyebrow">Аккаунт</p>
        <h2 id="profileTitle">Ваш профиль</h2>
        <div class="profile-top"><span class="avatar">${initials(state.profile.name)}</span><div><strong>${escapeHtml(state.profile.name)}</strong><span>${state.books.length} книг · ${state.books.filter(book => book.favorite).length} в избранном</span></div></div>
        <div class="field"><label for="profileName">Имя</label><input id="profileName" name="name" value="${escapeHtml(state.profile.name)}" required /></div>
        <div class="field"><label for="profileEmail">Электронная почта</label><input id="profileEmail" name="email" type="email" value="${escapeHtml(state.profile.email)}" required /></div>
        <div class="account-note">${icons.info}<span>В прототипе профиль и прогресс хранятся на этом устройстве. Для реальной синхронизации между телефоном и компьютером потребуется серверный аккаунт.</span></div>
        <div class="modal-actions"><button class="secondary-button" type="button" id="cancelProfile">Отмена</button><button class="primary-button" type="submit">Сохранить</button></div>
      </form>
    </div>`;
  const close = () => { root.innerHTML = ""; };
  root.querySelector(".close-button").addEventListener("click", close);
  root.querySelector("#cancelProfile").addEventListener("click", close);
  root.querySelector(".modal-backdrop").addEventListener("click", event => { if (event.target === event.currentTarget) close(); });
  root.querySelector("#profileForm").addEventListener("submit", event => {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    state.profile = { name: form.get("name").trim(), email: form.get("email").trim() };
    saveState();
    renderApp();
    showToast("Профиль сохранён");
  });
}

async function openReader(id) {
  activeBook = state.books.find(book => book.id === id);
  if (!activeBook) return;
  activeBook.lastRead = Date.now();
  saveState();
  const root = document.querySelector("#overlayRoot");
  root.innerHTML = readerMarkup(activeBook);
  bindReaderEvents();
  const stage = document.querySelector("#readerStage");

  if (activeBook.sample) {
    renderSampleBook(stage, activeBook);
    return;
  }
  try {
    const stored = await getBookFile(activeBook.id);
    if (!stored?.file) throw new Error("missing file");
    if (activeBook.format === "PDF") {
      await renderPdf(stage, activeBook, stored.file);
    } else if (activeBook.format === "FB2") {
      renderFb2(stage, activeBook, stored.content || []);
    } else if (activeBook.format === "EPUB") {
      await renderEpub(stage, activeBook, stored.file);
    }
  } catch (error) {
    stage.innerHTML = `<div class="reader-placeholder"><div><h2>Файл недоступен</h2><p>Книга могла быть удалена из хранилища браузера. Загрузите её снова.</p></div></div>`;
  }
}

function readerMarkup(book) {
  return `
    <section class="reader" id="reader" data-theme="${state.readerTheme}" style="--reader-size:${state.readerSize}px">
      <header class="reader-toolbar">
        <button class="reader-tool-button" id="closeReader">${icons.back}<span>К библиотеке</span></button>
        <div class="reader-title"><strong>${escapeHtml(book.title)}</strong><span>${escapeHtml(book.author)}</span></div>
        <div class="reader-tools">
          <button class="reader-tool-button" id="themeButton" title="Сменить фон">◐</button>
          <button class="reader-tool-button" id="fontButton" title="Размер текста">Аа</button>
        </div>
      </header>
      <main class="reader-stage" id="readerStage"><div class="reader-placeholder"><div><h2>Открываем книгу…</h2></div></div></main>
      <footer class="reader-footer">
        <div class="reader-nav"><button class="round-button" id="readerPrev" aria-label="Назад">${icons.arrowLeft}</button><span class="reader-position">Назад</span></div>
        <div class="reader-progress"><span class="page-label" id="readerPageLabel">${book.page && book.pages ? `${book.page} / ${book.pages}` : ""}</span><div class="progress-track"><div class="progress-fill" id="readerProgressFill" style="width:${book.progress}%"></div></div><span id="readerProgressValue">${Math.round(book.progress)}%</span></div>
        <div class="reader-nav"><span class="reader-position">Дальше</span><button class="round-button" id="readerNext" aria-label="Вперёд">${icons.arrowRight}</button></div>
      </footer>
    </section>`;
}

function bindReaderEvents() {
  document.querySelector("#closeReader")?.addEventListener("click", closeReader);
  document.querySelector("#themeButton")?.addEventListener("click", () => {
    const themes = ["paper", "sepia", "dark"];
    state.readerTheme = themes[(themes.indexOf(state.readerTheme) + 1) % themes.length];
    document.querySelector("#reader").dataset.theme = state.readerTheme;
    saveState();
  });
  document.querySelector("#fontButton")?.addEventListener("click", () => {
    state.readerSize = state.readerSize >= 23 ? 17 : state.readerSize + 2;
    document.querySelector("#reader").style.setProperty("--reader-size", `${state.readerSize}px`);
    if (rendition) rendition.themes.fontSize(`${state.readerSize}px`);
    saveState();
  });
  document.querySelector("#readerPrev")?.addEventListener("click", readerPrevious);
  document.querySelector("#readerNext")?.addEventListener("click", readerNext);
  document.addEventListener("keydown", readerKeyboard);
}

function readerKeyboard(event) {
  if (!activeBook) return;
  if (event.key === "Escape") closeReader();
  if (event.key === "ArrowLeft") readerPrevious();
  if (event.key === "ArrowRight") readerNext();
}

function renderSampleBook(stage, book) {
  const paragraphs = [...sampleText, ...sampleText, ...sampleText];
  stage.innerHTML = `<div class="reader-scroll" id="readerScroll"><article class="reader-article"><h1>${escapeHtml(book.title)}</h1><div class="chapter-author">${escapeHtml(book.author)}</div>${paragraphs.map(text => `<p>${text}</p>`).join("")}</article></div>`;
  const scroll = document.querySelector("#readerScroll");
  requestAnimationFrame(() => {
    scroll.scrollTop = (scroll.scrollHeight - scroll.clientHeight) * (book.progress / 100);
  });
  scroll.addEventListener("scroll", () => {
    clearTimeout(scrollSaveTimer);
    scrollSaveTimer = setTimeout(() => {
      const max = scroll.scrollHeight - scroll.clientHeight;
      updateProgress(max > 0 ? (scroll.scrollTop / max) * 100 : 0);
    }, 100);
  }, { passive: true });
}

function renderFb2(stage, book, content) {
  const paragraphs = content.length ? content : ["В книге не найден текст для отображения."];
  stage.innerHTML = `<div class="reader-scroll" id="readerScroll"><article class="reader-article"><h1>${escapeHtml(book.title)}</h1><div class="chapter-author">${escapeHtml(book.author)}</div>${paragraphs.map(text => `<p>${escapeHtml(text)}</p>`).join("")}</article></div>`;
  const scroll = document.querySelector("#readerScroll");
  requestAnimationFrame(() => { scroll.scrollTop = (scroll.scrollHeight - scroll.clientHeight) * (book.progress / 100); });
  scroll.addEventListener("scroll", () => {
    clearTimeout(scrollSaveTimer);
    scrollSaveTimer = setTimeout(() => {
      const max = scroll.scrollHeight - scroll.clientHeight;
      updateProgress(max > 0 ? (scroll.scrollTop / max) * 100 : 0);
    }, 100);
  }, { passive: true });
}

async function renderEpub(stage, book, file) {
  stage.innerHTML = '<div class="epub-stage" id="epubStage"></div>';
  const epubBook = ePub(await file.arrayBuffer());
  rendition = epubBook.renderTo("epubStage", { width: "100%", height: "100%", flow: "paginated" });
  rendition.themes.default({ body: { "font-family": "Georgia, serif", "line-height": "1.7", padding: "0 4%" } });
  rendition.themes.fontSize(`${state.readerSize}px`);
  if (book.location) await rendition.display(book.location);
  else await rendition.display();
  epubBook.ready.then(() => epubBook.locations.generate(1200));
  rendition.on("relocated", location => {
    book.location = location.start.cfi;
    const percentage = epubBook.locations.length() ? epubBook.locations.percentageFromCfi(location.start.cfi) * 100 : book.progress;
    updateProgress(percentage);
  });
}

async function renderPdf(stage, book, file) {
  stage.innerHTML = '<div class="pdf-stage" id="pdfStage"><div class="pdf-page"><canvas id="pdfCanvas"></canvas></div></div>';
  pdfjs ||= await import("pdfjs-dist");
  pdfjs.GlobalWorkerOptions.workerSrc = pdfWorkerUrl;
  pdfDocument = await pdfjs.getDocument({ data: await file.arrayBuffer() }).promise;
  book.pages = pdfDocument.numPages;
  book.page = Math.max(1, Math.min(book.pages, book.page || Math.round((book.progress / 100) * book.pages) || 1));
  await renderPdfPage(book.page);
  window.addEventListener("resize", resizePdfPage);
}

async function renderPdfPage(pageNumber) {
  if (!pdfDocument || !activeBook) return;
  if (pdfRenderTask) {
    try { pdfRenderTask.cancel(); } catch { /* A completed task cannot be cancelled. */ }
  }
  const page = await pdfDocument.getPage(pageNumber);
  const stage = document.querySelector("#pdfStage");
  const canvas = document.querySelector("#pdfCanvas");
  if (!stage || !canvas) return;
  const baseViewport = page.getViewport({ scale: 1 });
  const cssScale = Math.min(1.35, Math.max(.25, (stage.clientWidth - 40) / baseViewport.width));
  const outputScale = Math.min(window.devicePixelRatio || 1, 2);
  const viewport = page.getViewport({ scale: cssScale * outputScale });
  const context = canvas.getContext("2d");
  canvas.width = Math.floor(viewport.width);
  canvas.height = Math.floor(viewport.height);
  canvas.style.width = `${Math.floor(viewport.width / outputScale)}px`;
  canvas.style.height = `${Math.floor(viewport.height / outputScale)}px`;
  const renderTask = page.render({ canvasContext: context, viewport });
  pdfRenderTask = renderTask;
  try { await renderTask.promise; } catch (error) {
    if (error?.name === "RenderingCancelledException") return;
    throw error;
  }
  if (renderTask !== pdfRenderTask) return;
  activeBook.page = pageNumber;
  updateProgress((pageNumber / pdfDocument.numPages) * 100);
  const pageLabel = document.querySelector("#readerPageLabel");
  if (pageLabel) pageLabel.textContent = `${pageNumber} / ${pdfDocument.numPages}`;
}

function resizePdfPage() {
  clearTimeout(pdfResizeTimer);
  pdfResizeTimer = setTimeout(() => activeBook?.page && renderPdfPage(activeBook.page), 140);
}

function readerPrevious() {
  if (pdfDocument) { renderPdfPage(Math.max(1, activeBook.page - 1)); return; }
  if (rendition) { rendition.prev(); return; }
  const scroll = document.querySelector("#readerScroll");
  if (scroll) scroll.scrollBy({ top: -scroll.clientHeight * .82, behavior: "smooth" });
  else updateProgress(Math.max(0, activeBook.progress - 3));
}

function readerNext() {
  if (pdfDocument) { renderPdfPage(Math.min(pdfDocument.numPages, activeBook.page + 1)); return; }
  if (rendition) { rendition.next(); return; }
  const scroll = document.querySelector("#readerScroll");
  if (scroll) scroll.scrollBy({ top: scroll.clientHeight * .82, behavior: "smooth" });
  else updateProgress(Math.min(100, activeBook.progress + 3));
}

function updateProgress(value) {
  if (!activeBook) return;
  activeBook.progress = Math.max(0, Math.min(100, value));
  activeBook.lastRead = Date.now();
  const fill = document.querySelector("#readerProgressFill");
  const label = document.querySelector("#readerProgressValue");
  if (fill) fill.style.width = `${activeBook.progress}%`;
  if (label) label.textContent = `${Math.round(activeBook.progress)}%`;
  saveState();
}

function closeReader() {
  window.removeEventListener("resize", resizePdfPage);
  if (pdfRenderTask) {
    try { pdfRenderTask.cancel(); } catch { /* It may already be complete. */ }
  }
  if (pdfDocument) pdfDocument.destroy();
  pdfRenderTask = null;
  pdfDocument = null;
  if (rendition) rendition.destroy();
  rendition = null;
  activeBook = null;
  document.removeEventListener("keydown", readerKeyboard);
  renderApp();
}

function showToast(message) {
  document.querySelector(".toast")?.remove();
  const toast = document.createElement("div");
  toast.className = "toast";
  toast.innerHTML = `${icons.check}<span>${escapeHtml(message)}</span>`;
  document.body.append(toast);
  setTimeout(() => toast.remove(), 2800);
}

renderApp();
