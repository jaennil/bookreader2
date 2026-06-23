import { useRef, useState, type DragEvent } from "react";
import { api } from "./api";
import { CloseIcon, UploadIcon } from "./icons";
import type { Book } from "./types";

interface UploadModalProps {
  onClose: () => void;
  onUploaded: (book: Book) => void;
}

export function UploadModal({ onClose, onUploaded }: UploadModalProps) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [dragging, setDragging] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [fileName, setFileName] = useState("");
  const [progress, setProgress] = useState(0);
  const [error, setError] = useState("");

  async function processFile(file: File) {
    const extension = file.name.split(".").pop()?.toLowerCase();
    if (!extension || !["pdf", "epub", "fb2"].includes(extension)) {
      setError("Поддерживаются только PDF, EPUB и FB2");
      return;
    }
    setUploading(true);
    setFileName(file.name);
    setProgress(18);
    setError("");
    try {
      const metadata = await readMetadata(file, extension);
      setProgress(46);
      const book = await api.upload(file, metadata.title, metadata.author);
      setProgress(100);
      window.setTimeout(() => onUploaded(book), 250);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Не удалось загрузить книгу");
      setUploading(false);
    }
  }

  function drop(event: DragEvent) {
    event.preventDefault();
    setDragging(false);
    const file = event.dataTransfer.files[0];
    if (file) void processFile(file);
  }

  return (
    <div className="modal-backdrop" role="dialog" aria-modal="true" aria-labelledby="upload-title" onMouseDown={event => event.target === event.currentTarget && onClose()}>
      <div className="modal wide">
        <button className="close-button" aria-label="Закрыть" onClick={onClose}><CloseIcon/></button>
        <p className="eyebrow">Новая книга</p>
        <h2 id="upload-title">Добавить на полку</h2>
        <p className="modal-intro">Файл загрузится в ваш аккаунт и станет доступен на других устройствах.</p>
        <button
          className={`drop-zone ${dragging ? "dragover" : ""}`}
          type="button"
          disabled={uploading}
          onClick={() => inputRef.current?.click()}
          onDragEnter={event => { event.preventDefault(); setDragging(true); }}
          onDragOver={event => event.preventDefault()}
          onDragLeave={() => setDragging(false)}
          onDrop={drop}
        >
          <input ref={inputRef} type="file" accept=".pdf,.epub,.fb2,application/pdf,application/epub+zip" hidden onChange={event => event.target.files?.[0] && void processFile(event.target.files[0])}/>
          <span className="upload-icon"><UploadIcon/></span>
          <strong>{uploading ? "Загружаем книгу…" : "Перетащите книгу сюда"}</strong>
          <p>{uploading ? fileName : "или нажмите, чтобы выбрать файл"}</p>
          <span className="format-list"><span>PDF</span><span>EPUB</span><span>FB2</span></span>
        </button>
        {uploading && <div className="upload-progress visible"><p><span>{fileName}</span><span>{progress}%</span></p><div className="progress-track"><div className="progress-fill" style={{ width: `${progress}%` }}/></div></div>}
        {error && <div className="form-error upload-error" role="alert">{error}</div>}
      </div>
    </div>
  );
}

async function readMetadata(file: File, extension: string): Promise<{ title: string; author?: string }> {
  const fallback = { title: file.name.replace(/\.[^.]+$/, ""), author: undefined };
  if (extension === "fb2") {
    const document = new DOMParser().parseFromString(await file.text(), "application/xml");
    if (document.querySelector("parsererror")) return fallback;
    const title = document.querySelector("description title-info book-title")?.textContent?.trim() || fallback.title;
    const first = document.querySelector("description title-info author first-name")?.textContent?.trim() || "";
    const last = document.querySelector("description title-info author last-name")?.textContent?.trim() || "";
    return { title, author: `${first} ${last}`.trim() || undefined };
  }
  if (extension === "epub") {
    try {
      const { default: ePub } = await import("epubjs");
      const book = ePub(await file.arrayBuffer());
      const metadata = await book.loaded.metadata;
      const result = { title: metadata.title || fallback.title, author: metadata.creator || undefined };
      book.destroy();
      return result;
    } catch {
      return fallback;
    }
  }
  return fallback;
}
