import { useCallback, useEffect, useRef, useState, type CSSProperties } from "react";
import pdfWorkerUrl from "pdfjs-dist/build/pdf.worker.min.mjs?url";
import { api } from "./api";
import { BackIcon, ChevronIcon } from "./icons";
import type { Book, BookUpdate } from "./types";

type Theme = "paper" | "sepia" | "dark";
type Navigation = { previous: () => void; next: () => void };
type PDFDocument = import("pdfjs-dist").PDFDocumentProxy;

interface ReaderProps {
  book: Book;
  onClose: () => void;
  onUpdate: (update: BookUpdate) => void;
}

interface ViewProps {
  blob: Blob;
  book: Book;
  onUpdate: (update: BookUpdate) => void;
  registerNavigation: (navigation: Navigation) => void;
  theme: Theme;
  fontSize: number;
}

export function Reader({ book, onClose, onUpdate }: ReaderProps) {
  const [blob, setBlob] = useState<Blob | null>(null);
  const [error, setError] = useState("");
  const [theme, setTheme] = useState<Theme>(() => (localStorage.getItem("polka-reader-theme") as Theme) || "paper");
  const [fontSize, setFontSize] = useState(() => Number(localStorage.getItem("polka-reader-size")) || 19);
  const [liveBook, setLiveBook] = useState(book);
  const navigation = useRef<Navigation>({ previous: () => undefined, next: () => undefined });
  const registerNavigation = useCallback((value: Navigation) => { navigation.current = value; }, []);

  useEffect(() => {
    let cancelled = false;
    api.bookBlob(book.id)
      .then(value => { if (!cancelled) setBlob(value); })
      .catch(caught => { if (!cancelled) setError(caught instanceof Error ? caught.message : "Файл недоступен"); });
    return () => { cancelled = true; };
  }, [book.id]);

  const update = useCallback((value: BookUpdate) => {
    setLiveBook(current => ({ ...current, ...value, updatedAt: new Date().toISOString() }));
    onUpdate(value);
  }, [onUpdate]);

  function cycleTheme() {
    const themes: Theme[] = ["paper", "sepia", "dark"];
    const next = themes[(themes.indexOf(theme) + 1) % themes.length];
    setTheme(next);
    localStorage.setItem("polka-reader-theme", next);
  }

  function cycleFontSize() {
    const next = fontSize >= 23 ? 17 : fontSize + 2;
    setFontSize(next);
    localStorage.setItem("polka-reader-size", String(next));
  }

  return (
    <section className="reader" data-theme={theme} style={{ "--reader-size": `${fontSize}px` } as CSSProperties}>
      <header className="reader-toolbar">
        <button className="reader-tool-button" onClick={onClose}><BackIcon/><span>К библиотеке</span></button>
        <div className="reader-title"><strong>{liveBook.title}</strong><span>{liveBook.author}</span></div>
        <div className="reader-tools">
          <button className="reader-tool-button" title="Сменить фон" onClick={cycleTheme}>◐</button>
          {liveBook.format !== "PDF" && <button className="reader-tool-button" title="Размер текста" onClick={cycleFontSize}>Аа</button>}
        </div>
      </header>
      <main className="reader-stage">
        {!blob && !error && <ReaderMessage title="Открываем книгу…"/>}
        {error && <ReaderMessage title="Файл недоступен" text={error}/>}
        {blob && liveBook.format === "PDF" && <PDFView blob={blob} book={liveBook} onUpdate={update} registerNavigation={registerNavigation} theme={theme} fontSize={fontSize}/>}
        {blob && liveBook.format === "EPUB" && <EPUBView blob={blob} book={liveBook} onUpdate={update} registerNavigation={registerNavigation} theme={theme} fontSize={fontSize}/>}
        {blob && liveBook.format === "FB2" && <FB2View blob={blob} book={liveBook} onUpdate={update} registerNavigation={registerNavigation} theme={theme} fontSize={fontSize}/>}
      </main>
      <footer className="reader-footer">
        <div className="reader-nav"><button className="round-button" aria-label="Назад" onClick={() => navigation.current.previous()}><BackIcon/></button><span className="reader-position">Назад</span></div>
        <div className="reader-progress">
          <span className="page-label">{liveBook.page && liveBook.pages ? `${liveBook.page} / ${liveBook.pages}` : ""}</span>
          <div className="progress-track"><div className="progress-fill" style={{ width: `${liveBook.progress}%` }}/></div>
          <span>{Math.round(liveBook.progress)}%</span>
        </div>
        <div className="reader-nav"><span className="reader-position">Дальше</span><button className="round-button" aria-label="Вперёд" onClick={() => navigation.current.next()}><ChevronIcon/></button></div>
      </footer>
    </section>
  );
}

function ReaderMessage({ title, text }: { title: string; text?: string }) {
  return <div className="reader-placeholder"><div><h2>{title}</h2>{text && <p>{text}</p>}</div></div>;
}

function FB2View({ blob, book, onUpdate, registerNavigation }: ViewProps) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const timer = useRef<number | undefined>(undefined);
  const [paragraphs, setParagraphs] = useState<string[] | null>(null);

  useEffect(() => {
    blob.text().then(text => {
      const document = new DOMParser().parseFromString(text, "application/xml");
      setParagraphs([...document.querySelectorAll("body section p")].map(node => node.textContent?.trim() || "").filter(Boolean));
    });
  }, [blob]);

  useEffect(() => {
    const scroll = scrollRef.current;
    if (!scroll || !paragraphs) return;
    scroll.scrollTop = (scroll.scrollHeight - scroll.clientHeight) * (book.progress / 100);
    registerNavigation({
      previous: () => scroll.scrollBy({ top: -scroll.clientHeight * .82, behavior: "smooth" }),
      next: () => scroll.scrollBy({ top: scroll.clientHeight * .82, behavior: "smooth" })
    });
  }, [book.progress, paragraphs, registerNavigation]);

  function handleScroll() {
    window.clearTimeout(timer.current);
    timer.current = window.setTimeout(() => {
      const scroll = scrollRef.current;
      if (!scroll) return;
      const maximum = scroll.scrollHeight - scroll.clientHeight;
      onUpdate({ progress: maximum > 0 ? scroll.scrollTop / maximum * 100 : 0 });
    }, 120);
  }

  if (!paragraphs) return <ReaderMessage title="Разбираем FB2…"/>;
  return <div className="reader-scroll" ref={scrollRef} onScroll={handleScroll}><article className="reader-article"><h1>{book.title}</h1><div className="chapter-author">{book.author}</div>{paragraphs.length ? paragraphs.map((text, index) => <p key={index}>{text}</p>) : <p>В файле не найден текст.</p>}</article></div>;
}

function EPUBView({ blob, book, onUpdate, registerNavigation, theme, fontSize }: ViewProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const renditionRef = useRef<any>(null);
  const epubRef = useRef<any>(null);

  useEffect(() => {
    let disposed = false;
    blob.arrayBuffer().then(data => {
      if (disposed || !containerRef.current) return;
      return import("epubjs").then(({ default: ePub }) => {
        if (disposed || !containerRef.current) return;
        const epubBook = ePub(data);
        epubRef.current = epubBook;
        const rendition = epubBook.renderTo(containerRef.current, { width: "100%", height: "100%", flow: "paginated" });
        renditionRef.current = rendition;
        rendition.themes.default({ body: { "font-family": "Georgia, serif", "line-height": "1.7", padding: "0 4%" } });
        rendition.themes.fontSize(`${fontSize}px`);
        applyEpubTheme(rendition, theme);
        void rendition.display(book.location || undefined);
        void epubBook.ready.then(() => epubBook.locations.generate(1200));
        rendition.on("relocated", (location: any) => {
          const progress = epubBook.locations.length()
            ? epubBook.locations.percentageFromCfi(location.start.cfi) * 100
            : book.progress;
          onUpdate({ location: location.start.cfi, progress });
        });
        registerNavigation({ previous: () => rendition.prev(), next: () => rendition.next() });
      });
    }).catch(error => console.error(error));
    return () => {
      disposed = true;
      renditionRef.current?.destroy();
      epubRef.current?.destroy();
    };
  }, [blob]);

  useEffect(() => { renditionRef.current?.themes.fontSize(`${fontSize}px`); }, [fontSize]);
  useEffect(() => {
    const rendition = renditionRef.current;
    if (!rendition) return;
    applyEpubTheme(rendition, theme);
  }, [theme]);

  return <div className="epub-stage" ref={containerRef}/>;
}

function applyEpubTheme(rendition: any, theme: Theme) {
  const foreground = theme === "dark" ? "#d9dfda" : "#282e2b";
  const background = theme === "dark" ? "#17201d" : theme === "sepia" ? "#f4ead6" : "#f7f4ed";
  rendition.themes.override("color", foreground);
  rendition.themes.override("background", background);
}

function PDFView({ blob, book, onUpdate, registerNavigation }: ViewProps) {
  const stageRef = useRef<HTMLDivElement>(null);
  const scrollTimer = useRef<number | undefined>(undefined);
  const [document, setDocument] = useState<PDFDocument | null>(null);
  const [ratio, setRatio] = useState("1 / 1.414");
  const [currentPage, setCurrentPage] = useState(book.page || 1);

  useEffect(() => {
    let disposed = false;
    let loadedDocument: PDFDocument | null = null;
    let loadingTask: import("pdfjs-dist").PDFDocumentLoadingTask | null = null;
    void Promise.all([import("pdfjs-dist"), blob.arrayBuffer()]).then(async ([pdfjs, data]) => {
      pdfjs.GlobalWorkerOptions.workerSrc = pdfWorkerUrl;
      loadingTask = pdfjs.getDocument({ data });
      loadedDocument = await loadingTask.promise;
      if (disposed) {
        void loadingTask.destroy();
        return;
      }
      const firstPage = await loadedDocument.getPage(1);
      const viewport = firstPage.getViewport({ scale: 1 });
      setRatio(`${viewport.width} / ${viewport.height}`);
      setDocument(loadedDocument);
      onUpdate({ pages: loadedDocument.numPages });
    });
    return () => {
      disposed = true;
      if (loadingTask) void loadingTask.destroy();
    };
  }, [blob]);

  const goToPage = useCallback((page: number) => {
    if (!document || !stageRef.current) return;
    const target = Math.max(1, Math.min(document.numPages, page));
    const pageElement = stageRef.current.querySelector<HTMLElement>(`[data-pdf-page="${target}"]`);
    if (pageElement) stageRef.current.scrollTo({ top: Math.max(0, pageElement.offsetTop - 24), behavior: "smooth" });
  }, [document]);

  useEffect(() => {
    if (!document) return;
    registerNavigation({ previous: () => goToPage(currentPage - 1), next: () => goToPage(currentPage + 1) });
  }, [currentPage, document, goToPage, registerNavigation]);

  useEffect(() => {
    if (!document || !stageRef.current) return;
    window.requestAnimationFrame(() => {
      const page = Math.max(1, Math.min(document.numPages, book.page || 1));
      const target = stageRef.current?.querySelector<HTMLElement>(`[data-pdf-page="${page}"]`);
      if (target && stageRef.current) stageRef.current.scrollTop = Math.max(0, target.offsetTop - 24);
    });
  }, [document]);

  function handleScroll() {
    window.clearTimeout(scrollTimer.current);
    scrollTimer.current = window.setTimeout(() => {
      const stage = stageRef.current;
      if (!stage || !document) return;
      const readingLine = stage.scrollTop + stage.clientHeight * .38;
      let page = 1;
      stage.querySelectorAll<HTMLElement>("[data-pdf-page]").forEach(element => {
        if (element.offsetTop <= readingLine) page = Number(element.dataset.pdfPage);
      });
      if (page !== currentPage) {
        setCurrentPage(page);
        onUpdate({ page, pages: document.numPages, progress: page / document.numPages * 100 });
      }
    }, 70);
  }

  if (!document) return <ReaderMessage title="Разбираем PDF…"/>;
  return (
    <div className="pdf-stage" ref={stageRef} onScroll={handleScroll}>
      <div className="pdf-document">
        {Array.from({ length: document.numPages }, (_, index) => {
          const page = index + 1;
          return <PDFPage key={page} document={document} page={page} active={Math.abs(page - currentPage) <= 3} ratio={ratio}/>;
        })}
      </div>
    </div>
  );
}

function PDFPage({ document, page, active, ratio }: { document: PDFDocument; page: number; active: boolean; ratio: string }) {
  const wrapperRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    if (!active || !wrapperRef.current || !canvasRef.current) return;
    let task: import("pdfjs-dist").RenderTask | null = null;
    let cancelled = false;

    const render = async () => {
      const pdfPage = await document.getPage(page);
      if (cancelled || !wrapperRef.current || !canvasRef.current) return;
      const base = pdfPage.getViewport({ scale: 1 });
      const width = wrapperRef.current.clientWidth;
      const outputScale = Math.min(window.devicePixelRatio || 1, 2);
      const viewport = pdfPage.getViewport({ scale: width / base.width * outputScale });
      const canvas = canvasRef.current;
      canvas.width = Math.floor(viewport.width);
      canvas.height = Math.floor(viewport.height);
      canvas.style.height = `${Math.floor(viewport.height / outputScale)}px`;
      task = pdfPage.render({ canvas, canvasContext: canvas.getContext("2d")!, viewport });
      await task.promise;
    };
    void render().catch(error => {
      if (error?.name !== "RenderingCancelledException") console.error(error);
    });
    return () => {
      cancelled = true;
      task?.cancel();
    };
  }, [active, document, page]);

  return <div className="pdf-page" ref={wrapperRef} data-pdf-page={page} style={{ aspectRatio: ratio }}>{active && <canvas ref={canvasRef}/>}</div>;
}
