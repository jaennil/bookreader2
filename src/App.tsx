import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { api, APIError } from "./api";
import { AuthScreen } from "./AuthScreen";
import { Reader } from "./Reader";
import { UploadModal } from "./UploadModal";
import { BackIcon, CheckIcon, ChevronIcon, CloseIcon, CloudIcon, HeartIcon, LibraryIcon, PlusIcon, SearchIcon, TrashIcon, UploadIcon } from "./icons";
import type { Book, BookUpdate, User } from "./types";

type View = "library" | "favorites" | "uploads";
type Filter = "all" | "reading" | "new";

const palette = ["#925b54", "#315c69", "#676449", "#684d74", "#3e6657", "#9b7148"];
const styles = ["type", "sun", "orbit", "lines"];

export default function App() {
  const [user, setUser] = useState<User | null | undefined>(() => api.hasToken() ? undefined : null);
  const [books, setBooks] = useState<Book[]>([]);
  const [view, setView] = useState<View>("library");
  const [filter, setFilter] = useState<Filter>("all");
  const [query, setQuery] = useState("");
  const [showUpload, setShowUpload] = useState(false);
  const [showProfile, setShowProfile] = useState(false);
  const [activeBookID, setActiveBookID] = useState<string | null>(null);
  const [toast, setToast] = useState("");
  const [loadingBooks, setLoadingBooks] = useState(false);
  const saveTimers = useRef(new Map<string, number>());

  useEffect(() => {
    if (!api.hasToken()) {
      setUser(null);
      return;
    }
    api.me().then(setUser).catch(() => {
      api.clearToken();
      setUser(null);
    });
  }, []);

  useEffect(() => {
    if (!user) return;
    setLoadingBooks(true);
    api.books()
      .then(setBooks)
      .catch(error => notify(error instanceof Error ? error.message : "Не удалось загрузить библиотеку"))
      .finally(() => setLoadingBooks(false));
  }, [user]);

  const notify = useCallback((message: string) => {
    setToast(message);
    window.setTimeout(() => setToast(current => current === message ? "" : current), 2800);
  }, []);

  const visibleBooks = useMemo(() => books.filter(book => {
    if (view === "favorites" && !book.favorite) return false;
    if (filter === "reading" && !(book.progress > 0 && book.progress < 100)) return false;
    if (filter === "new" && book.progress !== 0) return false;
    if (query && !`${book.title} ${book.author}`.toLowerCase().includes(query.toLowerCase())) return false;
    return true;
  }), [books, filter, query, view]);

  const latest = useMemo(() => [...books].filter(book => book.progress > 0).sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt))[0], [books]);
  const activeBook = books.find(book => book.id === activeBookID);

  function authenticated(nextUser: User) {
    setUser(nextUser);
  }

  async function logout() {
    await api.logout();
    setBooks([]);
    setShowProfile(false);
    setUser(null);
  }

  function uploaded(book: Book) {
    setBooks(current => [book, ...current]);
    setShowUpload(false);
    notify(`«${book.title}» добавлена на полку`);
  }

  async function toggleFavorite(book: Book) {
    const favorite = !book.favorite;
    setBooks(current => current.map(item => item.id === book.id ? { ...item, favorite } : item));
    try {
      await api.updateBook(book.id, { favorite });
      notify(favorite ? "Добавлено в избранное" : "Удалено из избранного");
    } catch (error) {
      setBooks(current => current.map(item => item.id === book.id ? { ...item, favorite: book.favorite } : item));
      notify(error instanceof Error ? error.message : "Не удалось сохранить");
    }
  }

  async function deleteBook(book: Book) {
    if (!window.confirm(`Удалить «${book.title}» из библиотеки?`)) return;
    try {
      await api.deleteBook(book.id);
      setBooks(current => current.filter(item => item.id !== book.id));
      notify("Книга удалена");
    } catch (error) {
      notify(error instanceof Error ? error.message : "Не удалось удалить книгу");
    }
  }

  const updateReadingProgress = useCallback((id: string, update: BookUpdate) => {
    setBooks(current => current.map(book => book.id === id ? { ...book, ...update, updatedAt: new Date().toISOString() } : book));
    const previousTimer = saveTimers.current.get(id);
    if (previousTimer) window.clearTimeout(previousTimer);
    const timer = window.setTimeout(() => {
      api.updateBook(id, update).catch(error => {
        if (!(error instanceof APIError && error.status === 401)) notify("Не удалось синхронизировать прогресс");
      });
      saveTimers.current.delete(id);
    }, 350);
    saveTimers.current.set(id, timer);
  }, [notify]);

  if (user === undefined) return <div className="app-loading"><span className="brand-mark"/><span>Открываем Полку…</span></div>;
  if (!user) return <AuthScreen onAuthenticated={authenticated}/>;

  return (
    <>
      <div className="shell">
        <aside className="sidebar">
          <div className="brand"><span className="brand-mark"/><span>Полка</span></div>
          <nav className="main-nav" aria-label="Основная навигация">
            <span className="nav-label">Моя коллекция</span>
            <NavButton active={view === "library"} onClick={() => { setView("library"); setFilter("all"); }} icon={<LibraryIcon/>} label="Библиотека" count={books.length}/>
            <NavButton active={view === "favorites"} onClick={() => { setView("favorites"); setFilter("all"); }} icon={<HeartIcon/>} label="Избранное" count={books.filter(book => book.favorite).length}/>
            <NavButton active={view === "uploads"} onClick={() => { setView("uploads"); setFilter("all"); }} icon={<UploadIcon/>} label="Мои загрузки" count={books.length}/>
          </nav>
          <div className="sidebar-bottom"><div className="sync-card"><div className="sync-icon"><CloudIcon/></div><strong>Книги всегда рядом</strong><p>Прогресс синхронизируется с вашим аккаунтом.</p></div></div>
        </aside>

        <div className="content">
          <header className="topbar">
            <label className="search"><SearchIcon/><input type="search" placeholder="Найти книгу или автора" value={query} onChange={event => setQuery(event.target.value)}/></label>
            <button className="account-button" onClick={() => setShowProfile(true)}>
              <span className="avatar">{initials(user.name)}</span>
              <span className="account-copy"><strong>{user.name}</strong><span className="sync-status">Синхронизировано</span></span>
              <ChevronIcon/>
            </button>
          </header>

          <main className="main">
            <div className="page-heading">
              <div><p className="eyebrow">{view === "favorites" ? "Сохранённое" : view === "uploads" ? "Личные файлы" : "Моя библиотека"}</p><h1>{pageHeading(view, user.name, query)}</h1></div>
              <button className="primary-button" onClick={() => setShowUpload(true)}><PlusIcon/><span className="button-label">Добавить книгу</span></button>
            </div>

            {view === "library" && !query && latest && <ContinueCard book={latest} onOpen={() => setActiveBookID(latest.id)}/>}

            <section className="library-section">
              <div className="section-heading">
                <h2>{query ? `Найдено: ${visibleBooks.length}` : view === "favorites" ? "Любимые книги" : view === "uploads" ? "Загруженные файлы" : "Все книги"}</h2>
                <div className="filter-tabs" role="tablist">
                  <FilterButton active={filter === "all"} onClick={() => setFilter("all")}>Все</FilterButton>
                  <FilterButton active={filter === "reading"} onClick={() => setFilter("reading")}>Читаю</FilterButton>
                  <FilterButton active={filter === "new"} onClick={() => setFilter("new")}>Новые</FilterButton>
                </div>
              </div>
              <div className="book-grid">
                {loadingBooks ? <EmptyState title="Загружаем библиотеку…" text=""/> : visibleBooks.length ? visibleBooks.map(book => <BookCard key={book.id} book={book} onOpen={() => setActiveBookID(book.id)} onFavorite={() => void toggleFavorite(book)} onDelete={() => void deleteBook(book)}/>) : <EmptyState title={query ? "Ничего не найдено" : "На полке пока пусто"} text={query ? "Попробуйте изменить запрос" : "Добавьте первую книгу в PDF, EPUB или FB2"}/>}
              </div>
            </section>
          </main>
        </div>
      </div>

      <nav className="mobile-nav">
        <button className={view === "library" ? "active" : ""} onClick={() => setView("library")}><LibraryIcon/><span>Книги</span></button>
        <button className={view === "favorites" ? "active" : ""} onClick={() => setView("favorites")}><HeartIcon/><span>Избранное</span></button>
        <button onClick={() => setShowUpload(true)}><PlusIcon/><span>Добавить</span></button>
        <button onClick={() => setShowProfile(true)}><span className="avatar">{initials(user.name)}</span><span>Профиль</span></button>
      </nav>

      {showUpload && (
        <UploadModal onClose={() => setShowUpload(false)} onUploaded={uploaded}/>
      )}
      {showProfile && (
        <ProfileModal user={user} books={books} onClose={() => setShowProfile(false)} onLogout={() => void logout()}/>
      )}
      {activeBook && <Reader book={activeBook} onClose={() => setActiveBookID(null)} onUpdate={update => updateReadingProgress(activeBook.id, update)}/>}
      {toast && <div className="toast"><CheckIcon/><span>{toast}</span></div>}
    </>
  );
}

function NavButton({ active, onClick, icon, label, count }: { active: boolean; onClick: () => void; icon: React.ReactNode; label: string; count: number }) {
  return <button className={`nav-item ${active ? "active" : ""}`} onClick={onClick}>{icon}<span>{label}</span><span className="nav-count">{count}</span></button>;
}

function FilterButton({ active, onClick, children }: { active: boolean; onClick: () => void; children: React.ReactNode }) {
  return <button className={`filter-tab ${active ? "active" : ""}`} onClick={onClick}>{children}</button>;
}

function ContinueCard({ book, onOpen }: { book: Book; onOpen: () => void }) {
  const cover = coverData(book);
  return <section className="continue-card"><div className="mini-cover" style={{ background: cover.color, color: cover.textColor }}><div className="cover-title">{book.title}</div><div className="cover-art">{cover.decoration}</div></div><div className="continue-info"><p className="eyebrow">Продолжить чтение</p><h2>{book.title}</h2><p className="book-author">{book.author}</p><div className="progress-row"><Progress value={book.progress}/><span className="progress-value">{Math.round(book.progress)}%</span></div></div><div className="continue-action"><button className="primary-button light" onClick={onOpen}>Читать дальше <ChevronIcon/></button><span className="last-read">{relativeTime(book.updatedAt)}</span></div></section>;
}

function BookCard({ book, onOpen, onFavorite, onDelete }: { book: Book; onOpen: () => void; onFavorite: () => void; onDelete: () => void }) {
  const cover = coverData(book);
  return <article className="book-card" onClick={onOpen}><div className="cover-shell"><div className={`book-cover style-${cover.style}`} style={{ background: cover.color, color: cover.textColor }}><span className="cover-kicker">{book.format} · Полка</span><div className="cover-title">{book.title}</div><span className="cover-decoration">{cover.decoration}</span><span className="cover-author">{book.author}</span><span className="format-badge">{book.format}</span></div><button className={`favorite-button ${book.favorite ? "active" : ""}`} aria-label="Избранное" onClick={event => { event.stopPropagation(); onFavorite(); }}><HeartIcon/></button><button className="delete-button" aria-label="Удалить книгу" onClick={event => { event.stopPropagation(); onDelete(); }}><TrashIcon/></button></div><div className="book-meta"><h3>{book.title}</h3><p>{book.author} · {formatSize(book.size)}</p>{book.progress > 0 && <div className="card-progress"><Progress value={book.progress}/><span>{Math.round(book.progress)}%</span></div>}</div></article>;
}

function Progress({ value }: { value: number }) {
  return <div className="progress-track"><div className="progress-fill" style={{ width: `${value}%` }}/></div>;
}

function EmptyState({ title, text }: { title: string; text: string }) {
  return <div className="empty-state"><LibraryIcon/><h3>{title}</h3>{text && <p>{text}</p>}</div>;
}

function ProfileModal({ user, books, onClose, onLogout }: { user: User; books: Book[]; onClose: () => void; onLogout: () => void }) {
  return <div className="modal-backdrop" role="dialog" aria-modal="true" onMouseDown={event => event.target === event.currentTarget && onClose()}><div className="modal"><button className="close-button" onClick={onClose}><CloseIcon/></button><p className="eyebrow">Аккаунт</p><h2>Ваш профиль</h2><div className="profile-top"><span className="avatar">{initials(user.name)}</span><div><strong>{user.name}</strong><span>{books.length} книг · {books.filter(book => book.favorite).length} в избранном</span></div></div><div className="field"><span>Электронная почта</span><input value={user.email} readOnly/></div><div className="account-note"><CloudIcon/><span>Книги и прогресс хранятся в аккаунте. Войдите с тем же email на телефоне, чтобы продолжить чтение.</span></div><div className="modal-actions"><button className="secondary-button danger" onClick={onLogout}>Выйти</button><button className="primary-button" onClick={onClose}>Готово</button></div></div></div>;
}

function coverData(book: Book) {
  const hash = [...book.id].reduce((sum, char) => sum + char.charCodeAt(0), 0);
  return { color: palette[hash % palette.length], textColor: "#f8f3e7", style: styles[hash % styles.length], decoration: book.format[0] };
}

function initials(name: string) {
  return name.split(/\s+/).filter(Boolean).slice(0, 2).map(part => part[0]).join("").toUpperCase() || "Я";
}

function pageHeading(view: View, name: string, query: string) {
  if (query) return "Результаты поиска";
  if (view === "favorites") return "Избранное";
  if (view === "uploads") return "Мои загрузки";
  const hour = new Date().getHours();
  const greeting = hour < 6 ? "Доброй ночи" : hour < 12 ? "Доброе утро" : hour < 18 ? "Добрый день" : "Добрый вечер";
  return `${greeting}, ${name.split(" ")[0]}`;
}

function relativeTime(value: string) {
  const minutes = Math.max(0, Math.floor((Date.now() - Date.parse(value)) / 60000));
  if (minutes < 1) return "Только что";
  if (minutes < 60) return `${minutes} мин. назад`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} ч. назад`;
  return `${Math.floor(hours / 24)} дн. назад`;
}

function formatSize(bytes: number) {
  if (bytes < 1024 * 1024) return `${Math.max(1, Math.round(bytes / 1024))} КБ`;
  return `${(bytes / 1024 / 1024).toFixed(1)} МБ`;
}
