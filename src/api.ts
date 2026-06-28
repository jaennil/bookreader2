import type { AuthPayload, Book, BookUpdate, PDFTextPagePayload, User } from "./types";

const TOKEN_KEY = "polka-auth-token";

export class APIError extends Error {
  status: number;

  constructor(message: string, status: number) {
    super(message);
    this.status = status;
  }
}

function token(): string | null {
  return localStorage.getItem(TOKEN_KEY);
}

async function request<T>(path: string, options: RequestInit = {}): Promise<T> {
  const headers = new Headers(options.headers);
  const authToken = token();
  if (authToken) headers.set("Authorization", `Bearer ${authToken}`);
  if (options.body && !(options.body instanceof FormData)) headers.set("Content-Type", "application/json");

  const response = await fetch(path, { ...options, headers });
  if (!response.ok) {
    const payload = await response.json().catch(() => ({ error: "Ошибка сервера" }));
    throw new APIError(payload.error || "Ошибка сервера", response.status);
  }
  if (response.status === 204) return undefined as T;
  return response.json() as Promise<T>;
}

export const api = {
  hasToken: () => Boolean(token()),

  saveToken(value: string) {
    localStorage.setItem(TOKEN_KEY, value);
  },

  clearToken() {
    localStorage.removeItem(TOKEN_KEY);
  },

  register(name: string, email: string, password: string) {
    return request<AuthPayload>("/api/auth/register", {
      method: "POST",
      body: JSON.stringify({ name, email, password })
    });
  },

  login(email: string, password: string) {
    return request<AuthPayload>("/api/auth/login", {
      method: "POST",
      body: JSON.stringify({ email, password })
    });
  },

  me() {
    return request<User>("/api/me");
  },

  async logout() {
    try {
      await request<void>("/api/auth/session", { method: "DELETE" });
    } finally {
      api.clearToken();
    }
  },

  books() {
    return request<Book[]>("/api/books");
  },

  upload(file: File, title?: string, author?: string) {
    const body = new FormData();
    body.append("file", file);
    if (title) body.append("title", title);
    if (author) body.append("author", author);
    return request<Book>("/api/books", { method: "POST", body });
  },

  updateBook(id: string, update: BookUpdate) {
    return request<Book>(`/api/books/${id}`, { method: "PATCH", body: JSON.stringify(update) });
  },

  deleteBook(id: string) {
    return request<void>(`/api/books/${id}`, { method: "DELETE" });
  },

  pdfTextPages(id: string, from: number, to: number, pages?: number) {
    const query = new URLSearchParams({ from: String(from), to: String(to) });
    if (pages) query.set("pages", String(pages));
    return request<{ pages: PDFTextPagePayload[]; totalPages: number }>(`/api/books/${id}/pdf-text?${query}`);
  },

  async bookBlob(id: string, signal?: AbortSignal): Promise<Blob> {
    const response = await fetch(`/api/books/${id}/file`, {
      headers: token() ? { Authorization: `Bearer ${token()}` } : undefined,
      signal
    });
    if (!response.ok) throw new APIError("Не удалось загрузить файл книги", response.status);
    return response.blob();
  }
};
