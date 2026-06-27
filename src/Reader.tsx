import { useCallback, useEffect, useRef, useState, type CSSProperties } from "react";
import pdfWorkerUrl from "pdfjs-dist/build/pdf.worker.min.mjs?url";
import { api } from "./api";
import { BackIcon, ChevronIcon } from "./icons";
import type { Book, BookUpdate } from "./types";

type Theme = "paper" | "sepia" | "dark";
type PDFMode = "page" | "text";
type Navigation = { previous: () => void; next: () => void };
type PDFDocument = import("pdfjs-dist").PDFDocumentProxy;
type PDFPageProxy = import("pdfjs-dist").PDFPageProxy;
type PDFPageViewport = ReturnType<PDFPageProxy["getViewport"]>;
type PDFTextLayer = InstanceType<typeof import("pdfjs-dist").TextLayer>;
type PDFScrollAnchor = { page: number; offsetRatio: number };
type PDFTextPage = { page: number; paragraphs: string[] };
type PDFTextItem = { text: string; x: number; y: number; width: number; height: number };
type PDFDestinationTarget = { page: number; offsetRatio: number };
type PDFLinkAnnotation = {
  subtype?: string;
  rect?: number[];
  url?: string;
  unsafeUrl?: string;
  dest?: string | unknown[];
  action?: string;
  contents?: string | { str?: string };
};

const PDF_READING_LINE_RATIO = .38;

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
  const [pdfMode, setPdfMode] = useState<PDFMode>(() => {
    const saved = localStorage.getItem("polka-pdf-mode") as PDFMode | null;
    if (saved === "page" || saved === "text") return saved;
    return window.matchMedia("(max-width: 720px)").matches ? "text" : "page";
  });
  const [liveBook, setLiveBook] = useState(book);
  const pdfAnchor = useRef<PDFScrollAnchor>({ page: book.page || 1, offsetRatio: 0 });
  const navigation = useRef<Navigation>({ previous: () => undefined, next: () => undefined });
  const registerNavigation = useCallback((value: Navigation) => { navigation.current = value; }, []);

  useEffect(() => {
    let disposed = false;
    const controller = new AbortController();
    setLiveBook(book);
    pdfAnchor.current = { page: book.page || 1, offsetRatio: 0 };
    setBlob(null);
    setError("");
    registerNavigation({ previous: () => undefined, next: () => undefined });

    const load = async () => {
      for (let attempt = 0; attempt < 2; attempt += 1) {
        try {
          const value = await api.bookBlob(book.id, controller.signal);
          if (!disposed) {
            setBlob(value);
            setError("");
          }
          return;
        } catch (caught) {
          if (disposed || controller.signal.aborted) return;
          if (isAbortError(caught) && attempt === 0) continue;
          setError(caught instanceof Error ? caught.message : "Файл недоступен");
          return;
        }
      }
    };

    void load();
    return () => {
      disposed = true;
      controller.abort();
    };
  }, [book.id]);

  const update = useCallback((value: BookUpdate) => {
    setLiveBook(current => ({ ...current, ...value, updatedAt: new Date().toISOString() }));
    onUpdate(value);
  }, [onUpdate]);

  const rememberPDFAnchor = useCallback((anchor: PDFScrollAnchor) => {
    pdfAnchor.current = normalizePDFAnchor(anchor);
  }, []);

  function cycleTheme() {
    const themes: Theme[] = ["paper", "sepia", "dark"];
    const next = themes[(themes.indexOf(theme) + 1) % themes.length];
    setTheme(next);
    localStorage.setItem("polka-reader-theme", next);
  }

  function cycleFontSize() {
    const next = fontSize >= 29 ? 17 : fontSize + 2;
    setFontSize(next);
    localStorage.setItem("polka-reader-size", String(next));
  }

  function togglePDFMode() {
    const next = pdfMode === "text" ? "page" : "text";
    const anchor = normalizePDFAnchor(pdfAnchor.current, liveBook.pages);
    pdfAnchor.current = anchor;
    if (liveBook.format === "PDF") update(getPDFAnchorUpdate(anchor, liveBook.pages));
    setPdfMode(next);
    localStorage.setItem("polka-pdf-mode", next);
  }

  return (
    <section className="reader" data-theme={theme} style={{ "--reader-size": `${fontSize}px` } as CSSProperties}>
      <header className="reader-toolbar">
        <button className="reader-tool-button" onClick={onClose}><BackIcon/><span>К библиотеке</span></button>
        <div className="reader-title"><strong>{liveBook.title}</strong><span>{liveBook.author}</span></div>
        <div className="reader-tools">
          <button className="reader-tool-button" title="Сменить фон" onClick={cycleTheme}>◐</button>
          {liveBook.format === "PDF" && <button className="reader-tool-button reader-mode-button" title={pdfMode === "text" ? "Показать оригинал PDF" : "Читать PDF как текст"} onClick={togglePDFMode}>{pdfMode === "text" ? "PDF" : "Текст"}</button>}
          {(liveBook.format !== "PDF" || pdfMode === "text") && <button className="reader-tool-button" title={`Размер текста: ${fontSize}px`} onClick={cycleFontSize}>Аа</button>}
        </div>
      </header>
      <main className="reader-stage">
        {!blob && !error && <ReaderMessage title="Открываем книгу…"/>}
        {error && <ReaderMessage title="Файл недоступен" text={error}/>}
        {blob && liveBook.format === "PDF" && <PDFView blob={blob} book={liveBook} onUpdate={update} registerNavigation={registerNavigation} theme={theme} fontSize={fontSize} mode={pdfMode} initialAnchor={pdfAnchor.current} onAnchorChange={rememberPDFAnchor}/>}
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

function isAbortError(value: unknown) {
  if (value instanceof DOMException && value.name === "AbortError") return true;
  return value instanceof Error && (value.name === "AbortError" || /aborted|abort/i.test(value.message));
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

function PDFView({ blob, book, fontSize, onUpdate, registerNavigation, mode, initialAnchor, onAnchorChange }: ViewProps & { mode: PDFMode; initialAnchor: PDFScrollAnchor; onAnchorChange: (anchor: PDFScrollAnchor) => void }) {
  const stageRef = useRef<HTMLDivElement>(null);
  const scrollTimer = useRef<number | undefined>(undefined);
  const resizeTimer = useRef<number | undefined>(undefined);
  const positionRef = useRef<PDFScrollAnchor>(initialAnchor);
  const preservingLayoutRef = useRef(false);
  const [document, setDocument] = useState<PDFDocument | null>(null);
  const [error, setError] = useState("");
  const [ratio, setRatio] = useState("1 / 1.414");
  const [pageWidth, setPageWidth] = useState(0);
  const [currentPage, setCurrentPage] = useState(book.page || 1);

  useEffect(() => {
    let disposed = false;
    let loadingTask: import("pdfjs-dist").PDFDocumentLoadingTask | null = null;
    setDocument(null);
    setError("");
    void (async () => {
      const [pdfjs, data] = await Promise.all([import("pdfjs-dist"), blob.arrayBuffer()]);
      if (disposed) return;
      pdfjs.GlobalWorkerOptions.workerSrc = pdfWorkerUrl;
      loadingTask = pdfjs.getDocument({ data });
      const loadedDocument = await loadingTask.promise;
      if (disposed) {
        void loadingTask.destroy();
        return;
      }
      const firstPage = await loadedDocument.getPage(1);
      const viewport = firstPage.getViewport({ scale: 1 });
      setRatio(`${viewport.width} / ${viewport.height}`);
      setDocument(loadedDocument);
      onUpdate({ pages: loadedDocument.numPages });
    })().catch(caught => {
      if (disposed || isAbortError(caught)) return;
      setError(caught instanceof Error ? caught.message : "PDF не удалось открыть");
    });
    return () => {
      disposed = true;
      if (loadingTask) void loadingTask.destroy();
    };
  }, [blob]);

  const rememberAnchor = useCallback((anchor: PDFScrollAnchor) => {
    const next = normalizePDFAnchor(anchor, document?.numPages);
    positionRef.current = next;
    onAnchorChange(next);
    return next;
  }, [document?.numPages, onAnchorChange]);

  const goToPage = useCallback((page: number, offsetRatio = 0) => {
    if (!document || !stageRef.current || mode !== "page") return;
    const target = Math.max(1, Math.min(document.numPages, page));
    const anchor = rememberAnchor({ page: target, offsetRatio });
    setCurrentPage(target);
    onUpdate(getPDFAnchorUpdate(anchor, document.numPages));
    const pageElement = stageRef.current.querySelector<HTMLElement>(`[data-pdf-page="${target}"]`);
    if (pageElement) {
      const offset = Math.max(0, pageElement.clientHeight * Math.min(1, Math.max(0, offsetRatio)));
      stageRef.current.scrollTo({ top: Math.max(0, pageElement.offsetTop + offset - 24), behavior: "smooth" });
    }
  }, [document, mode, onUpdate, rememberAnchor]);

  useEffect(() => {
    if (!document || mode !== "page") return;
    registerNavigation({ previous: () => goToPage(currentPage - 1), next: () => goToPage(currentPage + 1) });
  }, [currentPage, document, goToPage, mode, registerNavigation]);

  useEffect(() => {
    if (!document || !stageRef.current || mode !== "page") return;
    window.requestAnimationFrame(() => {
      const anchor = rememberAnchor(initialAnchor);
      const target = stageRef.current?.querySelector<HTMLElement>(`[data-pdf-page="${anchor.page}"]`);
      if (target && stageRef.current) scrollPDFToAnchor(stageRef.current, anchor);
    });
  }, [document, mode]);

  useEffect(() => {
    if (!document || !stageRef.current || mode !== "page") return;
    const stage = stageRef.current;
    const documentElement = stage.querySelector<HTMLElement>(".pdf-document") || stage;
    let knownWidth = Math.round(documentElement.clientWidth);
    setPageWidth(knownWidth);

    const finishPreserving = () => {
      window.clearTimeout(resizeTimer.current);
      resizeTimer.current = window.setTimeout(() => { preservingLayoutRef.current = false; }, 260);
    };

    const restorePosition = () => {
      preservingLayoutRef.current = true;
      window.clearTimeout(scrollTimer.current);
      window.requestAnimationFrame(() => {
        window.requestAnimationFrame(() => {
          if (stageRef.current) scrollPDFToAnchor(stageRef.current, positionRef.current);
          finishPreserving();
        });
      });
    };

    const updateWidth = (width: number) => {
      const next = Math.round(width);
      if (!next || Math.abs(next - knownWidth) < 2) return;
      knownWidth = next;
      setPageWidth(next);
      restorePosition();
    };

    const resizeObserver = typeof ResizeObserver === "undefined"
      ? null
      : new ResizeObserver(entries => updateWidth(entries[0]?.contentRect.width || documentElement.clientWidth));
    resizeObserver?.observe(documentElement);

    const handleViewportChange = () => restorePosition();
    window.addEventListener("resize", handleViewportChange);
    window.addEventListener("orientationchange", handleViewportChange);

    return () => {
      resizeObserver?.disconnect();
      window.removeEventListener("resize", handleViewportChange);
      window.removeEventListener("orientationchange", handleViewportChange);
      window.clearTimeout(resizeTimer.current);
    };
  }, [document, mode]);

  function handleScroll() {
    const visibleStage = stageRef.current;
    if (visibleStage && document && mode === "page" && !preservingLayoutRef.current) {
      rememberAnchor(getPDFScrollAnchor(visibleStage));
    }
    window.clearTimeout(scrollTimer.current);
    scrollTimer.current = window.setTimeout(() => {
      const stage = stageRef.current;
      if (!stage || !document || mode !== "page") return;
      if (preservingLayoutRef.current) return;
      const anchor = rememberAnchor(getPDFScrollAnchor(stage));
      const page = anchor.page;
      if (page !== currentPage) {
        setCurrentPage(page);
      }
      onUpdate(getPDFAnchorUpdate(anchor, document.numPages));
    }, 70);
  }

  if (error) return <ReaderMessage title="PDF не удалось открыть" text={error}/>;
  if (!document) return <ReaderMessage title="Разбираем PDF…"/>;
  if (mode === "text") {
    return <PDFTextFlow document={document} book={book} fontSize={fontSize} initialAnchor={initialAnchor} onAnchorChange={onAnchorChange} onUpdate={onUpdate} registerNavigation={registerNavigation}/>;
  }
  return (
    <div className="pdf-stage" ref={stageRef} onScroll={handleScroll}>
      <div className="pdf-document">
        {Array.from({ length: document.numPages }, (_, index) => {
          const page = index + 1;
          return <PDFPage key={page} document={document} page={page} active={Math.abs(page - currentPage) <= 3} ratio={ratio} pageWidth={pageWidth} onInternalLink={goToPage}/>;
        })}
      </div>
    </div>
  );
}

function PDFTextFlow({ document, book, fontSize, initialAnchor, onAnchorChange, onUpdate, registerNavigation }: { document: PDFDocument; book: Book; fontSize: number; initialAnchor: PDFScrollAnchor; onAnchorChange: (anchor: PDFScrollAnchor) => void; onUpdate: (update: BookUpdate) => void; registerNavigation: (navigation: Navigation) => void }) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const scrollTimer = useRef<number | undefined>(undefined);
  const resizeTimer = useRef<number | undefined>(undefined);
  const restoredRef = useRef(false);
  const positionRef = useRef<PDFScrollAnchor>(initialAnchor);
  const [pages, setPages] = useState<PDFTextPage[]>([]);
  const [loaded, setLoaded] = useState(0);
  const [currentPage, setCurrentPage] = useState(book.page || 1);
  const hasAnyText = pages.some(page => page.paragraphs.length > 0);
  const restorePosition = useCallback(() => {
    const scroll = scrollRef.current;
    if (!scroll) return;
    window.requestAnimationFrame(() => {
      scrollPDFTextToAnchor(scroll, positionRef.current);
      onAnchorChange(positionRef.current);
    });
  }, []);

  useEffect(() => {
    let cancelled = false;
    setPages([]);
    setLoaded(0);
    restoredRef.current = false;
    const anchor = normalizePDFAnchor(initialAnchor, document.numPages);
    const startPage = anchor.page;
    positionRef.current = anchor;
    onAnchorChange(anchor);
    setCurrentPage(startPage);
    onUpdate({ pages: document.numPages });

    void (async () => {
      const extracted = new Map<number, PDFTextPage>();
      for (const pageNumber of getPDFTextExtractionOrder(startPage, document.numPages)) {
        let paragraphs: string[] = [];
        try {
          const pdfPage = await document.getPage(pageNumber);
          if (cancelled) return;
          paragraphs = await extractPDFTextParagraphs(pdfPage);
          pdfPage.cleanup();
        } catch (error) {
          console.error(`PDF text extraction failed on page ${pageNumber}`, error);
        }
        if (cancelled) return;
        extracted.set(pageNumber, { page: pageNumber, paragraphs });
        setPages(Array.from(extracted.values()).sort((left, right) => left.page - right.page));
        setLoaded(extracted.size);
        await yieldToBrowser();
      }
    })().catch(error => console.error(error));

    return () => {
      cancelled = true;
      window.clearTimeout(scrollTimer.current);
      window.clearTimeout(resizeTimer.current);
    };
  }, [book.id, document]);

  useEffect(() => {
    const scroll = scrollRef.current;
    if (!scroll) return;
    registerNavigation({
      previous: () => scroll.scrollBy({ top: -scroll.clientHeight * .86, behavior: "smooth" }),
      next: () => scroll.scrollBy({ top: scroll.clientHeight * .86, behavior: "smooth" })
    });
  }, [registerNavigation]);

  useEffect(() => {
    const scroll = scrollRef.current;
    if (!scroll || restoredRef.current || pages.length === 0) return;
    const targetAnchor = normalizePDFAnchor(initialAnchor, document.numPages);
    if (!pages.some(page => page.page === targetAnchor.page)) return;
    restoredRef.current = true;
    positionRef.current = targetAnchor;
    onAnchorChange(targetAnchor);
    window.requestAnimationFrame(() => scrollPDFTextToAnchor(scroll, targetAnchor));
  }, [book.page, document.numPages, pages]);

  useEffect(() => {
    const scroll = scrollRef.current;
    if (!scroll || pages.length === 0) return;
    const anchor = positionRef.current;
    window.requestAnimationFrame(() => scrollPDFTextToAnchor(scroll, anchor));
  }, [pages.length]);

  useEffect(() => {
    restorePosition();
  }, [fontSize, restorePosition]);

  useEffect(() => {
    const handleViewportChange = () => {
      window.clearTimeout(resizeTimer.current);
      resizeTimer.current = window.setTimeout(restorePosition, 220);
    };
    window.addEventListener("resize", handleViewportChange);
    window.addEventListener("orientationchange", handleViewportChange);
    return () => {
      window.removeEventListener("resize", handleViewportChange);
      window.removeEventListener("orientationchange", handleViewportChange);
      window.clearTimeout(resizeTimer.current);
    };
  }, [restorePosition]);

  const rememberAnchor = useCallback(() => {
    const scroll = scrollRef.current;
    if (!scroll) return positionRef.current;
    const anchor = normalizePDFAnchor(getPDFTextScrollAnchor(scroll), document.numPages);
    positionRef.current = anchor;
    onAnchorChange(anchor);
    return anchor;
  }, [document.numPages, onAnchorChange]);

  function handleScroll() {
    rememberAnchor();
    window.clearTimeout(scrollTimer.current);
    scrollTimer.current = window.setTimeout(() => {
      const anchor = rememberAnchor();
      if (anchor.page !== currentPage) {
        setCurrentPage(anchor.page);
      }
      onUpdate(getPDFAnchorUpdate(anchor, document.numPages));
    }, 120);
  }

  return (
    <div className="pdf-text-flow-stage reader-scroll" ref={scrollRef} onScroll={handleScroll}>
      <article className="pdf-text-flow">
        <header className="pdf-text-flow-head">
          <p className="eyebrow">PDF в текстовом режиме</p>
          <h1>{book.title}</h1>
          <div className="chapter-author">{book.author}</div>
          <p>Текст извлечён из PDF и перевёрстан для телефона. Если в книге есть сложные схемы или таблицы, переключитесь в режим PDF.</p>
        </header>
        {pages.map(page => (
          <section className="pdf-text-flow-page" key={page.page} data-pdf-text-page={page.page}>
            <div className="pdf-text-page-label">Страница {page.page}</div>
            {page.paragraphs.length
              ? page.paragraphs.map((paragraph, index) => <p key={index}>{paragraph}</p>)
              : <p className="pdf-empty-page">На этой странице не найден текстовый слой.</p>}
          </section>
        ))}
        {loaded < document.numPages && <div className="pdf-text-loading">Извлекаем текст: {loaded} / {document.numPages}</div>}
        {loaded === document.numPages && !hasAnyText && <div className="pdf-text-loading">В этом PDF не найден текстовый слой. Похоже, это скан — используйте оригинальный PDF-режим.</div>}
      </article>
    </div>
  );
}

function getPDFScrollAnchor(stage: HTMLElement): PDFScrollAnchor {
  const readingLine = stage.scrollTop + stage.clientHeight * PDF_READING_LINE_RATIO;
  let anchor: PDFScrollAnchor = { page: 1, offsetRatio: 0 };
  stage.querySelectorAll<HTMLElement>("[data-pdf-page]").forEach(element => {
    if (element.offsetTop <= readingLine) {
      const page = Number(element.dataset.pdfPage) || 1;
      const offsetRatio = Math.min(1, Math.max(0, (readingLine - element.offsetTop) / Math.max(1, element.clientHeight)));
      anchor = { page, offsetRatio };
    }
  });
  return anchor;
}

function scrollPDFToAnchor(stage: HTMLElement, anchor: PDFScrollAnchor) {
  const pageElement = stage.querySelector<HTMLElement>(`[data-pdf-page="${anchor.page}"]`);
  if (!pageElement) return;
  const pageOffset = pageElement.clientHeight * Math.min(1, Math.max(0, anchor.offsetRatio));
  stage.scrollTop = Math.max(0, pageElement.offsetTop + pageOffset - stage.clientHeight * PDF_READING_LINE_RATIO);
}

function normalizePDFAnchor(anchor: PDFScrollAnchor, totalPages?: number): PDFScrollAnchor {
  const maximum = totalPages && totalPages > 0 ? totalPages : Number.MAX_SAFE_INTEGER;
  return {
    page: Math.max(1, Math.min(maximum, Math.round(anchor.page) || 1)),
    offsetRatio: Math.max(0, Math.min(1, anchor.offsetRatio || 0))
  };
}

function getPDFAnchorUpdate(anchor: PDFScrollAnchor, totalPages?: number): BookUpdate {
  const safeAnchor = normalizePDFAnchor(anchor, totalPages);
  if (!totalPages || totalPages <= 0) return { page: safeAnchor.page };
  return {
    page: safeAnchor.page,
    pages: totalPages,
    progress: Math.max(0, Math.min(100, (safeAnchor.page - 1 + safeAnchor.offsetRatio) / totalPages * 100))
  };
}

function getPDFTextExtractionOrder(startPage: number, totalPages: number) {
  const safeStart = Math.max(1, Math.min(totalPages, startPage));
  const pages: number[] = [];
  for (let page = safeStart; page <= totalPages; page += 1) pages.push(page);
  for (let page = safeStart - 1; page >= 1; page -= 1) pages.push(page);
  return pages;
}

function yieldToBrowser() {
  return new Promise<void>(resolve => window.setTimeout(resolve, 0));
}

function getPDFTextScrollAnchor(stage: HTMLElement): PDFScrollAnchor {
  const readingLine = stage.scrollTop + stage.clientHeight * PDF_READING_LINE_RATIO;
  let anchor: PDFScrollAnchor = { page: 1, offsetRatio: 0 };
  stage.querySelectorAll<HTMLElement>("[data-pdf-text-page]").forEach(element => {
    if (element.offsetTop <= readingLine) {
      const page = Number(element.dataset.pdfTextPage) || 1;
      const offsetRatio = Math.min(1, Math.max(0, (readingLine - element.offsetTop) / Math.max(1, element.clientHeight)));
      anchor = { page, offsetRatio };
    }
  });
  return anchor;
}

function scrollPDFTextToAnchor(stage: HTMLElement, anchor: PDFScrollAnchor) {
  const pageElement = stage.querySelector<HTMLElement>(`[data-pdf-text-page="${anchor.page}"]`);
  if (!pageElement) return;
  const pageOffset = pageElement.clientHeight * Math.min(1, Math.max(0, anchor.offsetRatio));
  stage.scrollTop = Math.max(0, pageElement.offsetTop + pageOffset - stage.clientHeight * PDF_READING_LINE_RATIO);
}

async function extractPDFTextParagraphs(page: PDFPageProxy) {
  const content = await page.getTextContent();
  const rawItems = (content.items as unknown[])
    .map(item => normalizePDFTextItem(item))
    .filter((item): item is PDFTextItem => Boolean(item?.text.trim()));
  if (!rawItems.length) return [];

  const sorted = rawItems.sort((left, right) => Math.abs(right.y - left.y) > 3 ? right.y - left.y : left.x - right.x);
  const lines: { items: PDFTextItem[]; y: number; height: number }[] = [];
  for (const item of sorted) {
    const current = lines[lines.length - 1];
    if (!current || Math.abs(current.y - item.y) > Math.max(2.5, item.height * .28)) {
      lines.push({ items: [item], y: item.y, height: item.height });
      continue;
    }
    current.items.push(item);
    current.y = (current.y + item.y) / 2;
    current.height = Math.max(current.height, item.height);
  }

  const cleanLines = lines
    .map(line => ({ text: renderPDFTextLine(line), y: line.y }))
    .filter(line => line.text.length > 0);
  if (!cleanLines.length) return [];

  const gaps = cleanLines.slice(1)
    .map((line, index) => Math.abs(cleanLines[index].y - line.y))
    .filter(gap => gap > 0);
  const medianGap = median(gaps) || 12;
  const paragraphs: string[] = [];
  let paragraph = "";

  cleanLines.forEach((line, index) => {
    const previous = cleanLines[index - 1];
    const gap = previous ? Math.abs(previous.y - line.y) : 0;
    const startsNewParagraph = Boolean(previous && gap > medianGap * 1.55);
    if (!paragraph || startsNewParagraph) {
      if (paragraph) paragraphs.push(paragraph);
      paragraph = line.text;
      return;
    }
    paragraph = mergePDFTextLine(paragraph, line.text);
  });
  if (paragraph) paragraphs.push(paragraph);

  return paragraphs.filter(text => text.trim().length > 0);
}

function normalizePDFTextItem(item: unknown) {
  if (!item || typeof item !== "object" || !("str" in item)) return null;
  const value = item as { str?: unknown; transform?: unknown; width?: unknown; height?: unknown };
  if (typeof value.str !== "string") return null;
  const transform = Array.isArray(value.transform) ? value.transform : [];
  const x = typeof transform[4] === "number" ? transform[4] : 0;
  const y = typeof transform[5] === "number" ? transform[5] : 0;
  const height = typeof value.height === "number" && Number.isFinite(value.height) ? value.height : 10;
  const width = typeof value.width === "number" && Number.isFinite(value.width) ? value.width : Math.max(0, value.str.length * height * .45);
  return { text: value.str, x, y, width, height };
}

function renderPDFTextLine(line: { items: PDFTextItem[]; height: number }) {
  const items = [...line.items].sort((left, right) => left.x - right.x);
  const spaceGap = Math.max(1.8, line.height * .22);
  let result = "";
  let previous: PDFTextItem | null = null;
  let pendingSpace = false;

  for (const item of items) {
    const normalized = item.text.replace(/\s+/g, " ");
    const text = normalized.trim();
    if (!text) {
      pendingSpace = pendingSpace || normalized.length > 0;
      previous = item;
      continue;
    }
    const gap = previous ? item.x - (previous.x + previous.width) : 0;
    const needsSpace = Boolean(previous && (pendingSpace || /^\s/.test(normalized) || gap > spaceGap));
    result = appendPDFTextRun(result, text, needsSpace);
    pendingSpace = /\s$/.test(normalized);
    previous = item;
  }

  return result.replace(/\s+/g, " ").trim();
}

function appendPDFText(left: string, right: string) {
  return appendPDFTextRun(left, right, true);
}

function appendPDFTextRun(left: string, right: string, insertSpace: boolean) {
  const text = right.trim();
  if (!text) return left;
  if (!left) return text;
  if (/^[,.;:!?…%)\]}»”]/.test(text)) return left + text;
  if (/[(\[{«“]$/.test(left)) return left + text;
  if (!insertSpace) return left + text;
  return `${left} ${text}`;
}

function mergePDFTextLine(paragraph: string, line: string) {
  if (paragraph.endsWith("-")) return paragraph.slice(0, -1) + line;
  return appendPDFText(paragraph, line);
}

function median(values: number[]) {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)];
}

function PDFPage({ document, page, active, ratio, pageWidth, onInternalLink }: { document: PDFDocument; page: number; active: boolean; ratio: string; pageWidth: number; onInternalLink: (page: number, offsetRatio?: number) => void }) {
  const wrapperRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const textLayerRef = useRef<HTMLDivElement>(null);
  const linkLayerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!active || !wrapperRef.current || !canvasRef.current || !textLayerRef.current || !linkLayerRef.current) return;
    let task: import("pdfjs-dist").RenderTask | null = null;
    let textLayer: PDFTextLayer | null = null;
    let cancelled = false;

    const render = async () => {
      const [pdfjs, pdfPage] = await Promise.all([import("pdfjs-dist"), document.getPage(page)]);
      if (cancelled || !wrapperRef.current || !canvasRef.current || !textLayerRef.current) return;
      const base = pdfPage.getViewport({ scale: 1 });
      const width = pageWidth || wrapperRef.current.clientWidth;
      const outputScale = Math.min(window.devicePixelRatio || 1, 2);
      const viewport = pdfPage.getViewport({ scale: width / base.width * outputScale });
      const cssViewport = pdfPage.getViewport({ scale: width / base.width });
      const canvas = canvasRef.current;
      wrapperRef.current.style.aspectRatio = `${base.width} / ${base.height}`;
      canvas.width = Math.floor(viewport.width);
      canvas.height = Math.floor(viewport.height);
      canvas.style.height = `${Math.floor(viewport.height / outputScale)}px`;
      textLayerRef.current.replaceChildren();
      textLayerRef.current.style.setProperty("--total-scale-factor", String(cssViewport.scale));
      task = pdfPage.render({ canvas, canvasContext: canvas.getContext("2d")!, viewport });
      textLayer = new pdfjs.TextLayer({
        textContentSource: pdfPage.streamTextContent({ includeMarkedContent: true }),
        container: textLayerRef.current,
        viewport: cssViewport
      });
      const annotations = await pdfPage.getAnnotations({ intent: "display" }) as PDFLinkAnnotation[];
      await Promise.all([task.promise, textLayer.render()]);
      if (cancelled || !linkLayerRef.current) return;
      renderPDFLinks({
        annotations,
        viewport: cssViewport,
        layer: linkLayerRef.current,
        document,
        currentPage: page,
        onInternalLink
      });
    };
    void render().catch(error => {
      if (error?.name !== "RenderingCancelledException") console.error(error);
    });
    return () => {
      cancelled = true;
      task?.cancel();
      textLayer?.cancel();
      textLayerRef.current?.replaceChildren();
      linkLayerRef.current?.replaceChildren();
    };
  }, [active, document, onInternalLink, page, pageWidth]);

  return (
    <div className="pdf-page" ref={wrapperRef} data-pdf-page={page} style={{ aspectRatio: ratio }}>
      {active && <><canvas ref={canvasRef}/><div className="pdf-text-layer textLayer" ref={textLayerRef}/><div className="pdf-link-layer" ref={linkLayerRef}/></>}
    </div>
  );
}

function renderPDFLinks({ annotations, viewport, layer, document, currentPage, onInternalLink }: { annotations: PDFLinkAnnotation[]; viewport: PDFPageViewport; layer: HTMLDivElement; document: PDFDocument; currentPage: number; onInternalLink: (page: number, offsetRatio?: number) => void }) {
  layer.replaceChildren();
  const anchors = annotations
    .filter(annotation => annotation.subtype === "Link" && Array.isArray(annotation.rect) && annotation.rect.length === 4)
    .map(annotation => createPDFLink(annotation, viewport, document, currentPage, onInternalLink))
    .filter((anchor): anchor is HTMLAnchorElement => anchor !== null);
  layer.replaceChildren(...anchors);
}

function createPDFLink(annotation: PDFLinkAnnotation, viewport: PDFPageViewport, document: PDFDocument, currentPage: number, onInternalLink: (page: number, offsetRatio?: number) => void) {
  if (!annotation.rect) return null;
  const rectangle = viewport.convertToViewportRectangle(annotation.rect);
  const left = Math.min(rectangle[0], rectangle[2]);
  const top = Math.min(rectangle[1], rectangle[3]);
  const width = Math.abs(rectangle[0] - rectangle[2]);
  const height = Math.abs(rectangle[1] - rectangle[3]);
  if (width <= 0 || height <= 0) return null;

  const anchor = window.document.createElement("a");
  anchor.className = "pdf-link";
  anchor.style.left = `${left / viewport.width * 100}%`;
  anchor.style.top = `${top / viewport.height * 100}%`;
  anchor.style.width = `${width / viewport.width * 100}%`;
  anchor.style.height = `${height / viewport.height * 100}%`;
  anchor.title = getPDFLinkTitle(annotation);
  anchor.setAttribute("aria-label", anchor.title || "PDF-ссылка");

  const url = getSafePDFLinkURL(annotation);
  if (url) {
    anchor.href = url;
    anchor.target = "_blank";
    anchor.rel = "noreferrer";
    return anchor;
  }

  const destination = annotation.dest;
  if (destination) {
    anchor.href = "#";
    anchor.addEventListener("click", event => {
      event.preventDefault();
      event.stopPropagation();
      void resolvePDFDestination(document, destination).then(target => {
        if (target) onInternalLink(target.page, target.offsetRatio);
      });
    });
    return anchor;
  }

  const targetPage = resolveNamedPDFAction(annotation.action, currentPage, document.numPages);
  if (targetPage) {
    anchor.href = "#";
    anchor.addEventListener("click", event => {
      event.preventDefault();
      event.stopPropagation();
      onInternalLink(targetPage);
    });
    return anchor;
  }

  return null;
}

function getSafePDFLinkURL(annotation: PDFLinkAnnotation) {
  const value = annotation.url || annotation.unsafeUrl;
  if (!value) return null;
  try {
    const url = new URL(value, window.location.href);
    return ["http:", "https:", "mailto:", "tel:"].includes(url.protocol) ? url.href : null;
  } catch {
    return null;
  }
}

function getPDFLinkTitle(annotation: PDFLinkAnnotation) {
  if (typeof annotation.contents === "string") return annotation.contents;
  if (annotation.contents?.str) return annotation.contents.str;
  return annotation.url || annotation.unsafeUrl || "Перейти по ссылке";
}

async function resolvePDFDestination(document: PDFDocument, destination: string | unknown[]): Promise<PDFDestinationTarget | null> {
  const resolved = typeof destination === "string" ? await document.getDestination(destination) : destination;
  if (!Array.isArray(resolved) || !resolved[0]) return null;
  try {
    const pageIndex = await document.getPageIndex(resolved[0] as any);
    const page = pageIndex + 1;
    const pdfPage = await document.getPage(page);
    const viewport = pdfPage.getViewport({ scale: 1 });
    return { page, offsetRatio: getPDFDestinationOffsetRatio(resolved, viewport) };
  } catch (error) {
    console.error(error);
    return null;
  }
}

function getPDFDestinationOffsetRatio(destination: unknown[], viewport: PDFPageViewport) {
  const mode = getPDFDestinationMode(destination[1]);
  const top = mode === "XYZ" ? getNumber(destination[3])
    : mode === "FitH" || mode === "FitBH" ? getNumber(destination[2])
      : mode === "FitR" ? getNumber(destination[5])
        : null;
  if (top === null) return 0;
  const [, y] = viewport.convertToViewportPoint(0, top);
  return Math.min(1, Math.max(0, y / viewport.height));
}

function getPDFDestinationMode(value: unknown) {
  if (typeof value === "string") return value;
  if (value && typeof value === "object" && "name" in value) return String((value as { name?: unknown }).name || "");
  return "";
}

function getNumber(value: unknown) {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function resolveNamedPDFAction(action: string | undefined, currentPage: number, pages: number) {
  if (action === "FirstPage") return 1;
  if (action === "PrevPage") return Math.max(1, currentPage - 1);
  if (action === "NextPage") return Math.min(pages, currentPage + 1);
  if (action === "LastPage") return pages;
  return null;
}
