import { api, APIError } from "./api";
import type { Book, BookFormat, BookUpdate, PDFTextPagePayload, User } from "./types";

const DB_NAME = "polka-offline";
const DB_VERSION = 1;
const CURRENT_USER_KEY = "polka-offline-user-id";
const LOCAL_BOOK_PREFIX = "local-";
const PDF_TEXT_BATCH_SIZE = 20;

type StoreName = "users" | "books" | "files" | "pdfTextPages" | "pdfImages" | "queue";
type SyncStatus = "synced" | "pending" | "offline" | "syncing" | "error";

interface UserRecord {
  id: string;
  user: User;
  updatedAt: string;
}

interface BookRecord {
  key: string;
  userId: string;
  book: Book;
  updatedAt: string;
}

interface FileRecord {
  key: string;
  userId: string;
  bookId: string;
  blob: Blob;
  name: string;
  type: string;
  updatedAt: string;
}

interface PDFTextRecord {
  key: string;
  userId: string;
  bookId: string;
  page: number;
  totalPages: number;
  payload: PDFTextPagePayload;
  updatedAt: string;
}

interface PDFImageRecord {
  key: string;
  userId: string;
  bookId: string;
  page: number;
  imageId: string;
  blob: Blob;
  updatedAt: string;
}

type QueueRecord =
  | {
      id: string;
      userId: string;
      type: "update";
      bookId: string;
      update: BookUpdate;
      createdAt: string;
    }
  | {
      id: string;
      userId: string;
      type: "delete";
      bookId: string;
      createdAt: string;
    }
  | {
      id: string;
      userId: string;
      type: "upload";
      bookId: string;
      title?: string;
      author?: string;
      createdAt: string;
    };

export interface SyncSummary {
  status: SyncStatus;
  pending: number;
  synced: number;
}

let dbPromise: Promise<IDBDatabase> | null = null;
let syncPromise: Promise<SyncSummary> | null = null;

export const offline = {
  isOnline,
  isNetworkError,
  isLocalBook,
  currentUserId,
  cacheUser,
  cachedUser,
  cachedBooks,
  books,
  uploadBook,
  updateBook,
  deleteBook,
  bookBlob,
  pdfTextPages,
  pdfImage,
  cacheBookForOffline,
  removeOfflineCopy,
  offlineBookIds,
  pendingCount,
  syncPending
};

function openDB() {
  if (!dbPromise) {
    dbPromise = new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open(DB_NAME, DB_VERSION);
      request.onerror = () => reject(request.error || new Error("IndexedDB недоступна"));
      request.onsuccess = () => resolve(request.result);
      request.onupgradeneeded = () => {
        const db = request.result;
        createStore(db, "users", "id");
        createStore(db, "books", "key");
        createStore(db, "files", "key");
        createStore(db, "pdfTextPages", "key");
        createStore(db, "pdfImages", "key");
        createStore(db, "queue", "id");
      };
    });
  }
  return dbPromise;
}

function createStore(db: IDBDatabase, name: StoreName, keyPath: string) {
  if (!db.objectStoreNames.contains(name)) db.createObjectStore(name, { keyPath });
}

async function store(name: StoreName, mode: IDBTransactionMode = "readonly") {
  const db = await openDB();
  return db.transaction(name, mode).objectStore(name);
}

async function requestResult<T>(request: IDBRequest<T>) {
  return new Promise<T>((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error || new Error("IndexedDB request failed"));
  });
}

async function getAll<T>(storeName: StoreName) {
  return requestResult<T[]>((await store(storeName)).getAll());
}

async function getRecord<T>(storeName: StoreName, key: IDBValidKey) {
  return requestResult<T | undefined>((await store(storeName)).get(key));
}

async function putRecord<T>(storeName: StoreName, value: T) {
  return requestResult((await store(storeName, "readwrite")).put(value));
}

async function deleteRecord(storeName: StoreName, key: IDBValidKey) {
  return requestResult((await store(storeName, "readwrite")).delete(key));
}

function bookKey(userId: string, bookId: string) {
  return `${userId}:${bookId}`;
}

function pdfTextKey(userId: string, bookId: string, page: number) {
  return `${userId}:${bookId}:${page}`;
}

function pdfImageKey(userId: string, bookId: string, page: number, imageId: string) {
  return `${userId}:${bookId}:${page}:${imageId}`;
}

function now() {
  return new Date().toISOString();
}

function currentUserId() {
  return localStorage.getItem(CURRENT_USER_KEY);
}

function setCurrentUserId(userId: string) {
  localStorage.setItem(CURRENT_USER_KEY, userId);
}

function isOnline() {
  return navigator.onLine !== false;
}

function isNetworkError(error: unknown) {
  if (error instanceof APIError) return false;
  if (error instanceof DOMException && error.name === "AbortError") return false;
  if (error instanceof Error && error.name === "AbortError") return false;
  return error instanceof TypeError || error instanceof Error;
}

function isLocalBook(bookId: string) {
  return bookId.startsWith(LOCAL_BOOK_PREFIX);
}

async function cacheUser(user: User) {
  setCurrentUserId(user.id);
  await putRecord<UserRecord>("users", { id: user.id, user, updatedAt: now() });
}

async function cachedUser() {
  const userId = currentUserId();
  if (userId) {
    const record = await getRecord<UserRecord>("users", userId);
    if (record) return record.user;
  }
  const users = await getAll<UserRecord>("users");
  return users.sort((left, right) => Date.parse(right.updatedAt) - Date.parse(left.updatedAt))[0]?.user || null;
}

async function cacheBook(userId: string, book: Book) {
  await putRecord<BookRecord>("books", { key: bookKey(userId, book.id), userId, book, updatedAt: now() });
}

async function cacheBooks(userId: string, values: Book[]) {
  await Promise.all(values.map(book => cacheBook(userId, book)));
}

async function cachedBook(userId: string, bookId: string) {
  return (await getRecord<BookRecord>("books", bookKey(userId, bookId)))?.book || null;
}

async function cachedBooks(userId: string) {
  const records = await getAll<BookRecord>("books");
  return records
    .filter(record => record.userId === userId)
    .map(record => record.book)
    .sort((left, right) => Date.parse(right.updatedAt) - Date.parse(left.updatedAt));
}

async function books(userId: string) {
  const local = await cachedBooks(userId);
  if (!isOnline()) return local;
  try {
    const pending = await queue(userId);
    const remote = await api.books();
    await cacheBooks(userId, remote);
    const merged = mergeRemoteWithPendingLocal(remote, local, pending);
    await cacheBooks(userId, merged.filter(book => pending.some(record => record.bookId === book.id)));
    return merged;
  } catch (error) {
    if (isNetworkError(error) && local.length) return local;
    throw error;
  }
}

async function uploadBook(userId: string, file: File, title?: string, author?: string) {
  if (isOnline()) {
    try {
      const book = await api.upload(file, title, author);
      await cacheBook(userId, book);
      await cacheFile(userId, book, file);
      return book;
    } catch (error) {
      if (!isNetworkError(error)) throw error;
    }
  }

  const localBook = createLocalBook(file, title, author);
  await cacheBook(userId, localBook);
  await cacheFile(userId, localBook, file);
  await putRecord<QueueRecord>("queue", {
    id: crypto.randomUUID(),
    userId,
    type: "upload",
    bookId: localBook.id,
    title: localBook.title,
    author: localBook.author,
    createdAt: now()
  });
  return localBook;
}

async function updateBook(userId: string, id: string, update: BookUpdate) {
  const cached = await cachedBook(userId, id);
  const optimistic = cached ? { ...cached, ...update, updatedAt: now() } : null;
  if (optimistic) await cacheBook(userId, optimistic);

  if (!isLocalBook(id) && isOnline()) {
    try {
      const saved = await api.updateBook(id, update);
      await cacheBook(userId, saved);
      return saved;
    } catch (error) {
      if (!isNetworkError(error)) throw error;
    }
  }

  await queueUpdate(userId, id, update);
  return optimistic;
}

async function deleteBook(userId: string, book: Book) {
  await deleteRecord("books", bookKey(userId, book.id));
  await removeOfflineCopy(userId, book.id);

  if (isLocalBook(book.id)) {
    await removeQueuedLocalBook(userId, book.id);
    return;
  }

  if (isOnline()) {
    try {
      await api.deleteBook(book.id);
      return;
    } catch (error) {
      if (!isNetworkError(error)) throw error;
    }
  }

  await putRecord<QueueRecord>("queue", {
    id: crypto.randomUUID(),
    userId,
    type: "delete",
    bookId: book.id,
    createdAt: now()
  });
}

async function bookBlob(book: Book, signal?: AbortSignal) {
  const userId = currentUserId();
  if (!userId) throw new Error("Нет локального пользователя");
  const cached = await cachedFile(userId, book.id);
  if (cached) return cached.blob;
  if (isLocalBook(book.id) || !isOnline()) throw new Error("Книга не сохранена для офлайна");

  const blob = await api.bookBlob(book.id, signal);
  if (!signal?.aborted) await cacheFile(userId, book, blob);
  return blob;
}

async function cacheFile(userId: string, book: Book, blob: Blob) {
  await putRecord<FileRecord>("files", {
    key: bookKey(userId, book.id),
    userId,
    bookId: book.id,
    blob,
    name: book.originalName,
    type: blob.type || mimeForFormat(book.format),
    updatedAt: now()
  });
}

async function cachedFile(userId: string, bookId: string) {
  return getRecord<FileRecord>("files", bookKey(userId, bookId));
}

async function pdfTextPages(id: string, from: number, to: number, pages?: number) {
  const userId = currentUserId();
  if (!userId) throw new Error("Нет локального пользователя");
  const local = await cachedPDFTextPages(userId, id, from, to);
  const expected = to - from + 1;
  if (local.pages.length === expected) return local;
  if (isLocalBook(id) || !isOnline()) {
    if (local.pages.length) return local;
    throw new Error("Текст PDF не сохранён для офлайна");
  }

  const remote = await api.pdfTextPages(id, from, to, pages);
  await Promise.all(remote.pages.map(page => cachePDFTextPage(userId, id, page, remote.totalPages)));
  return remote;
}

async function cachedPDFTextPages(userId: string, bookId: string, from: number, to: number) {
  const records = await Promise.all(
    Array.from({ length: to - from + 1 }, (_, index) => getRecord<PDFTextRecord>("pdfTextPages", pdfTextKey(userId, bookId, from + index)))
  );
  const pages = records
    .filter((record): record is PDFTextRecord => Boolean(record))
    .map(record => record.payload)
    .sort((left, right) => left.page - right.page);
  const totalPages = records.find(Boolean)?.totalPages || pages.at(-1)?.page || to;
  return { pages, totalPages: Math.max(totalPages, pages.at(-1)?.page || 0) };
}

async function cachePDFTextPage(userId: string, bookId: string, payload: PDFTextPagePayload, totalPages: number) {
  await putRecord<PDFTextRecord>("pdfTextPages", {
    key: pdfTextKey(userId, bookId, payload.page),
    userId,
    bookId,
    page: payload.page,
    totalPages,
    payload,
    updatedAt: now()
  });
}

async function pdfImage(id: string, page: number, image: string, signal?: AbortSignal) {
  const userId = currentUserId();
  if (!userId) throw new Error("Нет локального пользователя");
  const key = pdfImageKey(userId, id, page, image);
  const cached = await getRecord<PDFImageRecord>("pdfImages", key);
  if (cached) return cached.blob;
  if (isLocalBook(id) || !isOnline()) throw new Error("Иллюстрация не сохранена для офлайна");

  const blob = await api.pdfImage(id, page, image, signal);
  if (!signal?.aborted) {
    await putRecord<PDFImageRecord>("pdfImages", { key, userId, bookId: id, page, imageId: image, blob, updatedAt: now() });
  }
  return blob;
}

async function cacheBookForOffline(userId: string, book: Book, onProgress?: (progress: number) => void) {
  onProgress?.(4);
  await bookBlob(book);
  onProgress?.(18);

  if (book.format !== "PDF" || isLocalBook(book.id)) {
    onProgress?.(100);
    return;
  }

  const first = await pdfTextPages(book.id, 1, 1, book.pages);
  const totalPages = Math.max(1, first.totalPages || book.pages || 1);
  if (book.pages !== totalPages) await updateBook(userId, book.id, { pages: totalPages });

  let loaded = 1;
  await prefetchPDFImages(book.id, first.pages);
  onProgress?.(Math.min(95, 18 + loaded / totalPages * 77));

  for (let from = 2; from <= totalPages; from += PDF_TEXT_BATCH_SIZE) {
    const to = Math.min(totalPages, from + PDF_TEXT_BATCH_SIZE - 1);
    const batch = await pdfTextPages(book.id, from, to, totalPages);
    loaded += batch.pages.length;
    await prefetchPDFImages(book.id, batch.pages);
    onProgress?.(Math.min(98, 18 + loaded / totalPages * 77));
    await new Promise(resolve => window.setTimeout(resolve, 0));
  }

  onProgress?.(100);
}

async function prefetchPDFImages(bookId: string, pages: PDFTextPagePayload[]) {
  for (const page of pages) {
    for (const image of page.images || []) {
      await pdfImage(bookId, page.page, image.id).catch(error => {
        if (!isNetworkError(error)) console.error(error);
      });
    }
  }
}

async function removeOfflineCopy(userId: string, bookId: string) {
  await deleteRecord("files", bookKey(userId, bookId));
  const [textPages, images] = await Promise.all([getAll<PDFTextRecord>("pdfTextPages"), getAll<PDFImageRecord>("pdfImages")]);
  await Promise.all([
    ...textPages.filter(record => record.userId === userId && record.bookId === bookId).map(record => deleteRecord("pdfTextPages", record.key)),
    ...images.filter(record => record.userId === userId && record.bookId === bookId).map(record => deleteRecord("pdfImages", record.key))
  ]);
}

async function offlineBookIds(userId: string) {
  const files = await getAll<FileRecord>("files");
  return new Set(files.filter(record => record.userId === userId).map(record => record.bookId));
}

async function pendingCount(userId: string) {
  return (await queue(userId)).length;
}

async function queue(userId: string) {
  return (await getAll<QueueRecord>("queue"))
    .filter(record => record.userId === userId)
    .sort((left, right) => Date.parse(left.createdAt) - Date.parse(right.createdAt));
}

async function queueUpdate(userId: string, bookId: string, update: BookUpdate) {
  const records = await queue(userId);
  const existing = [...records].reverse().find(record => record.type === "update" && record.bookId === bookId);
  if (existing?.type === "update") {
    await putRecord<QueueRecord>("queue", { ...existing, update: { ...existing.update, ...update }, createdAt: now() });
    return;
  }
  await putRecord<QueueRecord>("queue", { id: crypto.randomUUID(), userId, type: "update", bookId, update, createdAt: now() });
}

async function removeQueuedLocalBook(userId: string, bookId: string) {
  await Promise.all((await queue(userId)).filter(record => record.bookId === bookId).map(record => deleteRecord("queue", record.id)));
}

async function syncPending(userId: string) {
  if (!isOnline()) return { status: "offline", pending: await pendingCount(userId), synced: 0 } satisfies SyncSummary;
  if (syncPromise) return syncPromise;
  syncPromise = doSyncPending(userId).finally(() => { syncPromise = null; });
  return syncPromise;
}

async function doSyncPending(userId: string): Promise<SyncSummary> {
  let synced = 0;
  const records = await queue(userId);
  for (const record of records) {
    try {
      if (record.type === "upload") {
        await syncUpload(userId, record);
      } else if (record.type === "update") {
        if (isLocalBook(record.bookId)) continue;
        const saved = await api.updateBook(record.bookId, record.update);
        await cacheBook(userId, saved);
        await deleteRecord("queue", record.id);
      } else if (record.type === "delete") {
        if (!isLocalBook(record.bookId)) await api.deleteBook(record.bookId);
        await deleteRecord("queue", record.id);
      }
      synced += 1;
    } catch (error) {
      if (error instanceof APIError && error.status === 404) {
        await deleteRecord("queue", record.id);
        synced += 1;
        continue;
      }
      if (error instanceof APIError && error.status === 401) throw error;
      return { status: "pending", pending: await pendingCount(userId), synced };
    }
  }
  const pending = await pendingCount(userId);
  return { status: pending ? "pending" : "synced", pending, synced };
}

async function syncUpload(userId: string, record: Extract<QueueRecord, { type: "upload" }>) {
  const fileRecord = await cachedFile(userId, record.bookId);
  const localBook = await cachedBook(userId, record.bookId);
  if (!fileRecord || !localBook) {
    await deleteRecord("queue", record.id);
    return;
  }

  const file = new File([fileRecord.blob], fileRecord.name, { type: fileRecord.type || mimeForFormat(localBook.format) });
  const uploaded = await api.upload(file, record.title, record.author);
  const merged = mergeUploadedBook(localBook, uploaded);
  await deleteRecord("books", bookKey(userId, record.bookId));
  await deleteRecord("files", bookKey(userId, record.bookId));
  await cacheBook(userId, merged);
  await cacheFile(userId, merged, fileRecord.blob);
  await remapPDFCaches(userId, record.bookId, uploaded.id);
  await remapQueuedBookId(userId, record.bookId, uploaded.id, record.id);
  await deleteRecord("queue", record.id);

  const update = pendingUploadState(localBook);
  if (Object.keys(update).length) await queueUpdate(userId, uploaded.id, update);
}

async function remapQueuedBookId(userId: string, oldId: string, newId: string, exceptId: string) {
  await Promise.all((await queue(userId))
    .filter(record => record.id !== exceptId && record.bookId === oldId)
    .map(record => putRecord<QueueRecord>("queue", { ...record, bookId: newId } as QueueRecord)));
}

async function remapPDFCaches(userId: string, oldId: string, newId: string) {
  const [textPages, images] = await Promise.all([getAll<PDFTextRecord>("pdfTextPages"), getAll<PDFImageRecord>("pdfImages")]);
  await Promise.all([
    ...textPages.filter(record => record.userId === userId && record.bookId === oldId).flatMap(record => [
      putRecord<PDFTextRecord>("pdfTextPages", { ...record, key: pdfTextKey(userId, newId, record.page), bookId: newId }),
      deleteRecord("pdfTextPages", record.key)
    ]),
    ...images.filter(record => record.userId === userId && record.bookId === oldId).flatMap(record => [
      putRecord<PDFImageRecord>("pdfImages", { ...record, key: pdfImageKey(userId, newId, record.page, record.imageId), bookId: newId }),
      deleteRecord("pdfImages", record.key)
    ])
  ]);
}

function mergeUploadedBook(localBook: Book, uploaded: Book) {
  return {
    ...uploaded,
    progress: localBook.progress,
    location: localBook.location,
    page: localBook.page,
    pages: localBook.pages || uploaded.pages,
    favorite: localBook.favorite,
    finishedAt: localBook.finishedAt,
    updatedAt: now()
  };
}

function pendingUploadState(book: Book): BookUpdate {
  return {
    ...(book.progress ? { progress: book.progress } : {}),
    ...(book.location ? { location: book.location } : {}),
    ...(book.page ? { page: book.page } : {}),
    ...(book.pages ? { pages: book.pages } : {}),
    ...(book.favorite ? { favorite: book.favorite } : {}),
    ...(book.finishedAt ? { finishedAt: book.finishedAt } : {})
  };
}

function createLocalBook(file: File, title?: string, author?: string): Book {
  const createdAt = now();
  return {
    id: `${LOCAL_BOOK_PREFIX}${crypto.randomUUID()}`,
    title: title || file.name.replace(/\.[^.]+$/, ""),
    author: author || "Неизвестный автор",
    format: formatFromName(file.name),
    originalName: file.name,
    size: file.size,
    progress: 0,
    favorite: false,
    createdAt,
    updatedAt: createdAt
  };
}

function mergeRemoteWithPendingLocal(remote: Book[], local: Book[], pending: QueueRecord[]) {
  if (!pending.length) return remote;
  const pendingBookIds = new Set(pending.map(record => record.bookId));
  const localById = new Map(local.map(book => [book.id, book]));
  const remoteIds = new Set(remote.map(book => book.id));
  const merged = remote.map(book => pendingBookIds.has(book.id) && localById.has(book.id) ? localById.get(book.id)! : book);
  local.forEach(book => {
    if (!remoteIds.has(book.id) && pendingBookIds.has(book.id)) merged.unshift(book);
  });
  return merged;
}

function formatFromName(name: string): BookFormat {
  const extension = name.split(".").pop()?.toLowerCase();
  if (extension === "epub") return "EPUB";
  if (extension === "fb2") return "FB2";
  return "PDF";
}

function mimeForFormat(format: BookFormat) {
  if (format === "PDF") return "application/pdf";
  if (format === "EPUB") return "application/epub+zip";
  return "application/xml";
}
