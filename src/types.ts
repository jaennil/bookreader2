export type BookFormat = "PDF" | "EPUB" | "FB2";

export interface User {
  id: string;
  name: string;
  email: string;
  createdAt: string;
}

export interface Book {
  id: string;
  title: string;
  author: string;
  format: BookFormat;
  originalName: string;
  size: number;
  progress: number;
  location?: string;
  page?: number;
  pages?: number;
  favorite: boolean;
  finishedAt?: string;
  createdAt: string;
  updatedAt: string;
}

export interface AuthPayload {
  token: string;
  user: User;
}

export interface BookUpdate {
  title?: string;
  author?: string;
  progress?: number;
  location?: string;
  page?: number;
  pages?: number;
  favorite?: boolean;
  finishedAt?: string;
}

export interface PDFTextPagePayload {
  page: number;
  paragraphs: string[];
}
