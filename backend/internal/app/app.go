package app

import (
	"context"
	"crypto/hmac"
	"crypto/rand"
	"crypto/sha256"
	"crypto/subtle"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"encoding/xml"
	"errors"
	"fmt"
	"image"
	"image/png"
	"io"
	"log"
	"math"
	"mime"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"sort"
	"strconv"
	"strings"
	"sync"
	"time"
	"unicode"
	"unicode/utf8"
)

const (
	maxUploadSize       = 100 << 20
	passwordRounds      = 120_000
	sessionLifetime     = 30 * 24 * time.Hour
	stateFileName       = "state.json"
	bookDirectory       = "books"
	pdfTextDirectory    = "pdf-text"
	pdfImageDirectory   = "pdf-images"
	pdfTextCacheVersion = 6
	pdfImageDPI         = 144
)

var (
	errNotFound = errors.New("not found")
	errConflict = errors.New("already exists")
)

type User struct {
	ID           string    `json:"id"`
	Name         string    `json:"name"`
	Email        string    `json:"email"`
	PasswordHash string    `json:"passwordHash,omitempty"`
	PasswordSalt string    `json:"passwordSalt,omitempty"`
	CreatedAt    time.Time `json:"createdAt"`
}

type PublicUser struct {
	ID        string    `json:"id"`
	Name      string    `json:"name"`
	Email     string    `json:"email"`
	CreatedAt time.Time `json:"createdAt"`
}

type Book struct {
	ID           string     `json:"id"`
	UserID       string     `json:"-"`
	Title        string     `json:"title"`
	Author       string     `json:"author"`
	Format       string     `json:"format"`
	OriginalName string     `json:"originalName"`
	StoredName   string     `json:"-"`
	Size         int64      `json:"size"`
	Progress     float64    `json:"progress"`
	Location     string     `json:"location,omitempty"`
	Page         int        `json:"page,omitempty"`
	Pages        int        `json:"pages,omitempty"`
	Favorite     bool       `json:"favorite"`
	FinishedAt   *time.Time `json:"finishedAt,omitempty"`
	CreatedAt    time.Time  `json:"createdAt"`
	UpdatedAt    time.Time  `json:"updatedAt"`
}

type Session struct {
	UserID    string    `json:"userId"`
	ExpiresAt time.Time `json:"expiresAt"`
}

type persistedState struct {
	Users    map[string]User    `json:"users"`
	Books    map[string]Book    `json:"books"`
	Sessions map[string]Session `json:"sessions"`
}

type diskBook struct {
	Book
	UserID     string `json:"userId"`
	StoredName string `json:"storedName"`
}

type diskState struct {
	Users    map[string]User     `json:"users"`
	Books    map[string]diskBook `json:"books"`
	Sessions map[string]Session  `json:"sessions"`
}

type App struct {
	mu        sync.RWMutex
	pdfTextMu sync.Mutex
	dataDir   string
	webDir    string
	state     persistedState
	mux       *http.ServeMux
}

func New(dataDir, webDir string) (*App, error) {
	if dataDir == "" {
		return nil, errors.New("data directory is required")
	}
	if err := os.MkdirAll(filepath.Join(dataDir, bookDirectory), 0o750); err != nil {
		return nil, fmt.Errorf("create data directory: %w", err)
	}
	if err := os.MkdirAll(filepath.Join(dataDir, pdfTextDirectory), 0o750); err != nil {
		return nil, fmt.Errorf("create pdf text cache directory: %w", err)
	}
	if err := os.MkdirAll(filepath.Join(dataDir, pdfImageDirectory), 0o750); err != nil {
		return nil, fmt.Errorf("create pdf image cache directory: %w", err)
	}

	a := &App{
		dataDir: dataDir,
		webDir:  webDir,
		state: persistedState{
			Users:    make(map[string]User),
			Books:    make(map[string]Book),
			Sessions: make(map[string]Session),
		},
		mux: http.NewServeMux(),
	}
	if err := a.load(); err != nil {
		return nil, err
	}
	a.routes()
	return a, nil
}

func (a *App) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("X-Content-Type-Options", "nosniff")
	w.Header().Set("Referrer-Policy", "same-origin")
	a.mux.ServeHTTP(w, r)
}

func (a *App) routes() {
	a.mux.HandleFunc("GET /api/health", a.health)
	a.mux.HandleFunc("POST /api/auth/register", a.register)
	a.mux.HandleFunc("POST /api/auth/login", a.login)
	a.mux.HandleFunc("DELETE /api/auth/session", a.logout)
	a.mux.HandleFunc("GET /api/me", a.me)
	a.mux.HandleFunc("GET /api/books", a.listBooks)
	a.mux.HandleFunc("POST /api/books", a.uploadBook)
	a.mux.HandleFunc("PATCH /api/books/{id}", a.updateBook)
	a.mux.HandleFunc("DELETE /api/books/{id}", a.deleteBook)
	a.mux.HandleFunc("GET /api/books/{id}/file", a.bookFile)
	a.mux.HandleFunc("GET /api/books/{id}/pdf-text", a.pdfText)
	a.mux.HandleFunc("GET /api/books/{id}/pdf-images/{page}/{image}", a.pdfImage)
	a.mux.HandleFunc("/", a.frontend)
}

func (a *App) health(w http.ResponseWriter, _ *http.Request) {
	writeJSON(w, http.StatusOK, map[string]string{"status": "ok"})
}

type authRequest struct {
	Name     string `json:"name"`
	Email    string `json:"email"`
	Password string `json:"password"`
}

func (a *App) register(w http.ResponseWriter, r *http.Request) {
	var input authRequest
	if err := readJSON(r, &input); err != nil {
		writeError(w, http.StatusBadRequest, "Некорректный запрос")
		return
	}
	input.Name = strings.TrimSpace(input.Name)
	input.Email = strings.ToLower(strings.TrimSpace(input.Email))
	if input.Name == "" || !strings.Contains(input.Email, "@") || len(input.Password) < 8 {
		writeError(w, http.StatusBadRequest, "Укажите имя, email и пароль не короче 8 символов")
		return
	}

	salt := make([]byte, 16)
	if _, err := rand.Read(salt); err != nil {
		writeError(w, http.StatusInternalServerError, "Не удалось создать аккаунт")
		return
	}
	user := User{
		ID:           randomID(16),
		Name:         input.Name,
		Email:        input.Email,
		PasswordHash: base64.RawStdEncoding.EncodeToString(derivePassword(input.Password, salt)),
		PasswordSalt: base64.RawStdEncoding.EncodeToString(salt),
		CreatedAt:    time.Now().UTC(),
	}
	token, err := a.createUserAndSession(user)
	if errors.Is(err, errConflict) {
		writeError(w, http.StatusConflict, "Аккаунт с таким email уже существует")
		return
	}
	if err != nil {
		log.Printf("register: %v", err)
		writeError(w, http.StatusInternalServerError, "Не удалось создать аккаунт")
		return
	}
	writeJSON(w, http.StatusCreated, map[string]any{"token": token, "user": publicUser(user)})
}

func (a *App) login(w http.ResponseWriter, r *http.Request) {
	var input authRequest
	if err := readJSON(r, &input); err != nil {
		writeError(w, http.StatusBadRequest, "Некорректный запрос")
		return
	}
	user, ok := a.userByEmail(strings.ToLower(strings.TrimSpace(input.Email)))
	if !ok || !passwordMatches(input.Password, user.PasswordSalt, user.PasswordHash) {
		writeError(w, http.StatusUnauthorized, "Неверный email или пароль")
		return
	}
	token, err := a.createSession(user.ID)
	if err != nil {
		log.Printf("login: %v", err)
		writeError(w, http.StatusInternalServerError, "Не удалось войти")
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"token": token, "user": publicUser(user)})
}

func (a *App) logout(w http.ResponseWriter, r *http.Request) {
	_, token, ok := a.authenticate(r)
	if !ok {
		writeError(w, http.StatusUnauthorized, "Требуется вход")
		return
	}
	a.mu.Lock()
	delete(a.state.Sessions, token)
	err := a.persistLocked()
	a.mu.Unlock()
	if err != nil {
		writeError(w, http.StatusInternalServerError, "Не удалось завершить сессию")
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

func (a *App) me(w http.ResponseWriter, r *http.Request) {
	userID, _, ok := a.authenticate(r)
	if !ok {
		writeError(w, http.StatusUnauthorized, "Требуется вход")
		return
	}
	a.mu.RLock()
	user, exists := a.state.Users[userID]
	a.mu.RUnlock()
	if !exists {
		writeError(w, http.StatusUnauthorized, "Сессия недействительна")
		return
	}
	writeJSON(w, http.StatusOK, publicUser(user))
}

func (a *App) listBooks(w http.ResponseWriter, r *http.Request) {
	userID, _, ok := a.authenticate(r)
	if !ok {
		writeError(w, http.StatusUnauthorized, "Требуется вход")
		return
	}
	a.mu.RLock()
	books := make([]Book, 0)
	for _, book := range a.state.Books {
		if book.UserID == userID {
			books = append(books, book)
		}
	}
	a.mu.RUnlock()
	sort.Slice(books, func(i, j int) bool { return books[i].UpdatedAt.After(books[j].UpdatedAt) })
	writeJSON(w, http.StatusOK, books)
}

func (a *App) uploadBook(w http.ResponseWriter, r *http.Request) {
	userID, _, ok := a.authenticate(r)
	if !ok {
		writeError(w, http.StatusUnauthorized, "Требуется вход")
		return
	}
	r.Body = http.MaxBytesReader(w, r.Body, maxUploadSize)
	if err := r.ParseMultipartForm(16 << 20); err != nil {
		writeError(w, http.StatusBadRequest, "Файл слишком большой или повреждён")
		return
	}
	defer r.MultipartForm.RemoveAll()
	file, header, err := r.FormFile("file")
	if err != nil {
		writeError(w, http.StatusBadRequest, "Выберите файл")
		return
	}
	defer file.Close()

	ext := strings.ToLower(filepath.Ext(header.Filename))
	format := strings.ToUpper(strings.TrimPrefix(ext, "."))
	if format != "PDF" && format != "EPUB" && format != "FB2" {
		writeError(w, http.StatusBadRequest, "Поддерживаются PDF, EPUB и FB2")
		return
	}
	id := randomID(16)
	storedName := id + ext
	targetPath := filepath.Join(a.dataDir, bookDirectory, storedName)
	temporary, err := os.CreateTemp(filepath.Join(a.dataDir, bookDirectory), ".upload-*")
	if err != nil {
		writeError(w, http.StatusInternalServerError, "Не удалось сохранить файл")
		return
	}
	temporaryName := temporary.Name()
	defer os.Remove(temporaryName)
	size, copyErr := io.Copy(temporary, file)
	closeErr := temporary.Close()
	if copyErr != nil || closeErr != nil || size == 0 {
		writeError(w, http.StatusBadRequest, "Не удалось прочитать файл")
		return
	}
	if err := os.Rename(temporaryName, targetPath); err != nil {
		writeError(w, http.StatusInternalServerError, "Не удалось сохранить файл")
		return
	}

	title := strings.TrimSpace(r.FormValue("title"))
	if title == "" {
		title = strings.TrimSuffix(filepath.Base(header.Filename), filepath.Ext(header.Filename))
	}
	author := strings.TrimSpace(r.FormValue("author"))
	if author == "" {
		author = "Неизвестный автор"
	}
	now := time.Now().UTC()
	book := Book{
		ID: id, UserID: userID, Title: title, Author: author, Format: format,
		OriginalName: filepath.Base(header.Filename), StoredName: storedName, Size: size,
		CreatedAt: now, UpdatedAt: now,
	}
	a.mu.Lock()
	a.state.Books[book.ID] = book
	err = a.persistLocked()
	if err != nil {
		delete(a.state.Books, book.ID)
	}
	a.mu.Unlock()
	if err != nil {
		os.Remove(targetPath)
		writeError(w, http.StatusInternalServerError, "Не удалось сохранить книгу")
		return
	}
	writeJSON(w, http.StatusCreated, book)
}

type bookUpdate struct {
	Title      *string    `json:"title"`
	Author     *string    `json:"author"`
	Progress   *float64   `json:"progress"`
	Location   *string    `json:"location"`
	Page       *int       `json:"page"`
	Pages      *int       `json:"pages"`
	Favorite   *bool      `json:"favorite"`
	FinishedAt *time.Time `json:"finishedAt"`
}

func (a *App) updateBook(w http.ResponseWriter, r *http.Request) {
	userID, _, ok := a.authenticate(r)
	if !ok {
		writeError(w, http.StatusUnauthorized, "Требуется вход")
		return
	}
	var input bookUpdate
	if err := readJSON(r, &input); err != nil {
		writeError(w, http.StatusBadRequest, "Некорректный запрос")
		return
	}
	a.mu.Lock()
	book, exists := a.state.Books[r.PathValue("id")]
	if !exists || book.UserID != userID {
		a.mu.Unlock()
		writeError(w, http.StatusNotFound, "Книга не найдена")
		return
	}
	if input.Title != nil && strings.TrimSpace(*input.Title) != "" {
		book.Title = strings.TrimSpace(*input.Title)
	}
	if input.Author != nil && strings.TrimSpace(*input.Author) != "" {
		book.Author = strings.TrimSpace(*input.Author)
	}
	if input.Progress != nil {
		book.Progress = min(100, max(0, *input.Progress))
	}
	if input.Location != nil {
		book.Location = *input.Location
	}
	if input.Page != nil {
		book.Page = max(0, *input.Page)
	}
	if input.Pages != nil {
		book.Pages = max(0, *input.Pages)
	}
	if input.Favorite != nil {
		book.Favorite = *input.Favorite
	}
	if input.FinishedAt != nil && book.FinishedAt == nil {
		finishedAt := input.FinishedAt.UTC()
		book.FinishedAt = &finishedAt
	}
	book.UpdatedAt = time.Now().UTC()
	a.state.Books[book.ID] = book
	err := a.persistLocked()
	a.mu.Unlock()
	if err != nil {
		writeError(w, http.StatusInternalServerError, "Не удалось сохранить изменения")
		return
	}
	writeJSON(w, http.StatusOK, book)
}

func (a *App) deleteBook(w http.ResponseWriter, r *http.Request) {
	userID, _, ok := a.authenticate(r)
	if !ok {
		writeError(w, http.StatusUnauthorized, "Требуется вход")
		return
	}
	a.mu.Lock()
	book, exists := a.state.Books[r.PathValue("id")]
	if !exists || book.UserID != userID {
		a.mu.Unlock()
		writeError(w, http.StatusNotFound, "Книга не найдена")
		return
	}
	delete(a.state.Books, book.ID)
	err := a.persistLocked()
	a.mu.Unlock()
	if err != nil {
		writeError(w, http.StatusInternalServerError, "Не удалось удалить книгу")
		return
	}
	if err := os.Remove(filepath.Join(a.dataDir, bookDirectory, book.StoredName)); err != nil && !errors.Is(err, os.ErrNotExist) {
		log.Printf("delete book file: %v", err)
	}
	a.pdfTextMu.Lock()
	if err := os.Remove(a.pdfTextCachePath(book.ID)); err != nil && !errors.Is(err, os.ErrNotExist) {
		log.Printf("delete pdf text cache: %v", err)
	}
	if err := os.RemoveAll(a.pdfImageBookDirectory(book.ID)); err != nil {
		log.Printf("delete pdf image cache: %v", err)
	}
	a.pdfTextMu.Unlock()
	w.WriteHeader(http.StatusNoContent)
}

func (a *App) bookFile(w http.ResponseWriter, r *http.Request) {
	userID, _, ok := a.authenticate(r)
	if !ok {
		writeError(w, http.StatusUnauthorized, "Требуется вход")
		return
	}
	a.mu.RLock()
	book, exists := a.state.Books[r.PathValue("id")]
	a.mu.RUnlock()
	if !exists || book.UserID != userID {
		writeError(w, http.StatusNotFound, "Книга не найдена")
		return
	}
	contentType := map[string]string{
		"PDF": "application/pdf", "EPUB": "application/epub+zip", "FB2": "application/xml",
	}[book.Format]
	w.Header().Set("Content-Type", contentType)
	w.Header().Set("Content-Disposition", mime.FormatMediaType("inline", map[string]string{"filename": book.OriginalName}))
	http.ServeFile(w, r, filepath.Join(a.dataDir, bookDirectory, book.StoredName))
}

type pdfTextPage struct {
	Page       int            `json:"page"`
	Paragraphs []string       `json:"paragraphs"`
	Images     []pdfTextImage `json:"images,omitempty"`
}

type pdfTextImage struct {
	ID             string  `json:"id"`
	AfterParagraph int     `json:"afterParagraph"`
	Left           float64 `json:"left"`
	Top            float64 `json:"top"`
	Width          float64 `json:"width"`
	Height         float64 `json:"height"`
	PageWidth      float64 `json:"pageWidth"`
	PageHeight     float64 `json:"pageHeight"`
}

type pdfTextPageCache struct {
	Paragraphs []string       `json:"paragraphs"`
	Images     []pdfTextImage `json:"images,omitempty"`
}

type pdfTextCache struct {
	Version int                      `json:"version"`
	Pages   map[int]pdfTextPageCache `json:"pages"`
}

func (a *App) pdfText(w http.ResponseWriter, r *http.Request) {
	userID, _, ok := a.authenticate(r)
	if !ok {
		writeError(w, http.StatusUnauthorized, "Требуется вход")
		return
	}
	a.mu.RLock()
	book, exists := a.state.Books[r.PathValue("id")]
	a.mu.RUnlock()
	if !exists || book.UserID != userID {
		writeError(w, http.StatusNotFound, "Книга не найдена")
		return
	}
	if book.Format != "PDF" {
		writeError(w, http.StatusBadRequest, "Текстовый fallback доступен только для PDF")
		return
	}

	filePath := filepath.Join(a.dataDir, bookDirectory, book.StoredName)
	totalPages := book.Pages
	if totalPages <= 0 {
		var err error
		totalPages, err = pdfPageCount(r.Context(), filePath)
		if err != nil {
			log.Printf("pdf page count: %v", err)
			totalPages = max(1, queryInt(r, "pages", 1))
		} else {
			a.rememberPDFPageCount(book.ID, totalPages)
		}
	}
	from := queryInt(r, "from", queryInt(r, "page", max(1, book.Page)))
	to := queryInt(r, "to", from)
	from = max(1, min(totalPages, from))
	to = max(from, min(totalPages, to))
	if to-from > 19 {
		to = from + 19
	}

	pages, err := a.cachedPDFTextPages(r.Context(), book.ID, filePath, from, to)
	if err != nil {
		log.Printf("pdf text pages %d-%d: %v", from, to, err)
	}
	w.Header().Set("Cache-Control", "private, no-cache")
	writeJSON(w, http.StatusOK, map[string]any{"pages": pages, "totalPages": totalPages})
}

func (a *App) pdfImage(w http.ResponseWriter, r *http.Request) {
	userID, _, ok := a.authenticate(r)
	if !ok {
		writeError(w, http.StatusUnauthorized, "Требуется вход")
		return
	}
	a.mu.RLock()
	book, exists := a.state.Books[r.PathValue("id")]
	a.mu.RUnlock()
	if !exists || book.UserID != userID || book.Format != "PDF" {
		writeError(w, http.StatusNotFound, "Книга не найдена")
		return
	}
	page, err := strconv.Atoi(r.PathValue("page"))
	if err != nil || page < 1 {
		writeError(w, http.StatusBadRequest, "Некорректная страница")
		return
	}

	a.pdfTextMu.Lock()
	cache, err := a.loadPDFTextCache(book.ID)
	if err != nil {
		a.pdfTextMu.Unlock()
		writeError(w, http.StatusNotFound, "Изображение не найдено")
		return
	}
	cachedPage := cache.Pages[page]
	var image *pdfTextImage
	for index := range cachedPage.Images {
		candidate := &cachedPage.Images[index]
		if candidate.ID == r.PathValue("image") {
			image = candidate
			break
		}
	}
	if image == nil {
		a.pdfTextMu.Unlock()
		writeError(w, http.StatusNotFound, "Изображение не найдено")
		return
	}
	imagePath := a.pdfImageCachePath(book.ID, page, image.ID)
	if _, err := os.Stat(imagePath); errors.Is(err, os.ErrNotExist) {
		filePath := filepath.Join(a.dataDir, bookDirectory, book.StoredName)
		if err := renderPDFImage(r.Context(), filePath, imagePath, page, *image); err != nil {
			a.pdfTextMu.Unlock()
			log.Printf("render pdf image %s page %d image %s: %v", book.ID, page, image.ID, err)
			writeError(w, http.StatusInternalServerError, "Не удалось подготовить изображение")
			return
		}
	} else if err != nil {
		a.pdfTextMu.Unlock()
		writeError(w, http.StatusInternalServerError, "Не удалось открыть изображение")
		return
	}
	a.pdfTextMu.Unlock()

	w.Header().Set("Content-Type", "image/png")
	w.Header().Set("Cache-Control", "private, max-age=31536000, immutable")
	http.ServeFile(w, r, imagePath)
}

func renderPDFImage(ctx context.Context, filePath, outputPath string, page int, image pdfTextImage) error {
	if image.PageWidth <= 0 || image.PageHeight <= 0 || image.Width <= 0 || image.Height <= 0 {
		return errors.New("invalid pdf image bounds")
	}
	if err := os.MkdirAll(filepath.Dir(outputPath), 0o750); err != nil {
		return err
	}
	directory, err := os.MkdirTemp(filepath.Dir(outputPath), ".render-*")
	if err != nil {
		return err
	}
	defer os.RemoveAll(directory)
	prefix := filepath.Join(directory, "image")
	scale := float64(pdfImageDPI) / 72
	x := max(0, int(math.Floor(image.Left*scale)))
	y := max(0, int(math.Floor(image.Top*scale)))
	width := max(1, int(math.Ceil(image.Width*scale)))
	height := max(1, int(math.Ceil(image.Height*scale)))
	commandContext, cancel := context.WithTimeout(ctx, 20*time.Second)
	defer cancel()
	command := exec.CommandContext(commandContext, "pdftoppm", "-q", "-cropbox", "-f", strconv.Itoa(page), "-l", strconv.Itoa(page), "-singlefile", "-r", strconv.Itoa(pdfImageDPI), "-x", strconv.Itoa(x), "-y", strconv.Itoa(y), "-W", strconv.Itoa(width), "-H", strconv.Itoa(height), "-png", filePath, prefix)
	if output, err := command.CombinedOutput(); err != nil {
		if commandContext.Err() != nil {
			return commandContext.Err()
		}
		return fmt.Errorf("pdftoppm: %w: %s", err, strings.TrimSpace(string(output)))
	}
	temporaryPath := prefix + ".png"
	if err := os.Chmod(temporaryPath, 0o600); err != nil {
		return err
	}
	return os.Rename(temporaryPath, outputPath)
}

func (a *App) cachedPDFTextPages(ctx context.Context, bookID, filePath string, from, to int) ([]pdfTextPage, error) {
	a.pdfTextMu.Lock()
	defer a.pdfTextMu.Unlock()

	cache, err := a.loadPDFTextCache(bookID)
	if err != nil {
		log.Printf("load pdf text cache: %v", err)
		cache = newPDFTextCache()
	}
	missingFrom, missingTo := 0, 0
	for page := from; page <= to; page++ {
		if _, exists := cache.Pages[page]; exists {
			continue
		}
		if missingFrom == 0 {
			missingFrom = page
		}
		missingTo = page
	}

	var extractionErr error
	if missingFrom > 0 {
		extracted, err := extractPDFTextPages(ctx, filePath, missingFrom, missingTo)
		if err != nil {
			extractionErr = err
		} else {
			for _, page := range extracted {
				cache.Pages[page.Page] = pdfTextPageCache{Paragraphs: page.Paragraphs, Images: page.Images}
			}
			if err := a.savePDFTextCache(bookID, cache); err != nil {
				extractionErr = fmt.Errorf("save cache: %w", err)
			}
		}
	}

	pages := make([]pdfTextPage, 0, to-from+1)
	for page := from; page <= to; page++ {
		cached := cache.Pages[page]
		pages = append(pages, pdfTextPage{Page: page, Paragraphs: cached.Paragraphs, Images: cached.Images})
	}
	return pages, extractionErr
}

func extractPDFTextPages(ctx context.Context, filePath string, from, to int) ([]pdfTextPage, error) {
	timeout := 12*time.Second + time.Duration(to-from)*1500*time.Millisecond
	ctx, cancel := context.WithTimeout(ctx, min(45*time.Second, timeout))
	defer cancel()
	output, err := exec.CommandContext(ctx, "pdftotext", "-enc", "UTF-8", "-f", strconv.Itoa(from), "-l", strconv.Itoa(to), "-layout", filePath, "-").Output()
	if ctx.Err() != nil {
		return nil, ctx.Err()
	}
	if err != nil {
		return nil, err
	}
	text := strings.ReplaceAll(string(output), "\r\n", "\n")
	text = strings.ReplaceAll(text, "\r", "\n")
	rawPages := strings.Split(text, "\f")
	pages := make([]pdfTextPage, 0, to-from+1)
	for page := from; page <= to; page++ {
		index := page - from
		pageText := ""
		if index < len(rawPages) {
			pageText = rawPages[index]
		}
		pages = append(pages, pdfTextPage{Page: page, Paragraphs: splitExtractedPDFText(pageText)})
	}
	images, err := extractPDFImageLayout(ctx, filePath, from, to, pages)
	if err != nil {
		return nil, err
	}
	for index := range pages {
		pages[index].Images = images[pages[index].Page]
	}
	return pages, nil
}

type pdfHTMLDocument struct {
	Pages []pdfHTMLPage `xml:"page"`
}

type pdfHTMLPage struct {
	Number int            `xml:"number,attr"`
	Width  float64        `xml:"width,attr"`
	Height float64        `xml:"height,attr"`
	Images []pdfHTMLImage `xml:"image"`
	Texts  []pdfHTMLText  `xml:"text"`
}

type pdfHTMLImage struct {
	Left   float64 `xml:"left,attr"`
	Top    float64 `xml:"top,attr"`
	Width  float64 `xml:"width,attr"`
	Height float64 `xml:"height,attr"`
}

type pdfHTMLText struct {
	Left   float64
	Top    float64
	Height float64
	Text   string
}

func (text *pdfHTMLText) UnmarshalXML(decoder *xml.Decoder, start xml.StartElement) error {
	for _, attribute := range start.Attr {
		value, err := strconv.ParseFloat(attribute.Value, 64)
		if err != nil {
			continue
		}
		switch attribute.Name.Local {
		case "left":
			text.Left = value
		case "top":
			text.Top = value
		case "height":
			text.Height = value
		}
	}
	var content strings.Builder
	for {
		token, err := decoder.Token()
		if err != nil {
			return err
		}
		switch value := token.(type) {
		case xml.CharData:
			content.Write(value)
		case xml.EndElement:
			if value.Name == start.Name {
				text.Text = content.String()
				return nil
			}
		}
	}
}

func extractPDFImageLayout(ctx context.Context, filePath string, from, to int, pages []pdfTextPage) (map[int][]pdfTextImage, error) {
	directory, err := os.MkdirTemp("", "bookreader-pdf-layout-*")
	if err != nil {
		return nil, err
	}
	defer os.RemoveAll(directory)
	xmlPath := filepath.Join(directory, "layout.xml")
	command := exec.CommandContext(ctx, "pdftohtml", "-q", "-xml", "-hidden", "-noroundcoord", "-f", strconv.Itoa(from), "-l", strconv.Itoa(to), "-zoom", "1", "-fmt", "png", filePath, xmlPath)
	if output, err := command.CombinedOutput(); err != nil {
		if ctx.Err() != nil {
			return nil, ctx.Err()
		}
		return nil, fmt.Errorf("pdftohtml: %w: %s", err, strings.TrimSpace(string(output)))
	}
	data, err := os.ReadFile(xmlPath)
	if err != nil {
		return nil, err
	}
	paragraphs := make(map[int][]string, len(pages))
	for _, page := range pages {
		paragraphs[page.Page] = page.Paragraphs
	}
	images, err := parsePDFImageLayout(data, paragraphs)
	if err != nil {
		return nil, err
	}
	var document pdfHTMLDocument
	if err := xml.Unmarshal(data, &document); err != nil {
		return nil, err
	}
	if err := addPDFPageFallbacks(ctx, filePath, directory, document.Pages, paragraphs, images); err != nil {
		return nil, err
	}
	return images, nil
}

func parsePDFImageLayout(data []byte, paragraphs map[int][]string) (map[int][]pdfTextImage, error) {
	var document pdfHTMLDocument
	if err := xml.Unmarshal(data, &document); err != nil {
		return nil, err
	}
	result := make(map[int][]pdfTextImage)
	for _, page := range document.Pages {
		if page.Width <= 0 || page.Height <= 0 {
			continue
		}
		sort.Slice(page.Texts, func(left, right int) bool {
			if page.Texts[left].Top == page.Texts[right].Top {
				return page.Texts[left].Left < page.Texts[right].Left
			}
			return page.Texts[left].Top < page.Texts[right].Top
		})
		sort.Slice(page.Images, func(left, right int) bool {
			if page.Images[left].Top == page.Images[right].Top {
				return page.Images[left].Left < page.Images[right].Left
			}
			return page.Images[left].Top < page.Images[right].Top
		})
		images := make([]pdfTextImage, 0, len(page.Images))
		for _, source := range page.Images {
			left := max(0.0, source.Left-1)
			top := max(0.0, source.Top-1)
			right := min(page.Width, source.Left+source.Width+1)
			bottom := min(page.Height, source.Top+source.Height+1)
			width, height := right-left, bottom-top
			if width < 16 || height < 16 || width*height < page.Width*page.Height*.002 {
				continue
			}
			candidate := pdfTextImage{
				ID:             strconv.Itoa(len(images) + 1),
				AfterParagraph: estimatePDFImageInsertion(paragraphs[page.Number], page.Texts, top),
				Left:           left,
				Top:            top,
				Width:          width,
				Height:         height,
				PageWidth:      page.Width,
				PageHeight:     page.Height,
			}
			if len(images) > 0 && samePDFImageBounds(images[len(images)-1], candidate) {
				continue
			}
			images = append(images, candidate)
		}
		if len(images) > 0 {
			result[page.Number] = images
		}
	}
	return result, nil
}

func estimatePDFImageInsertion(paragraphs []string, texts []pdfHTMLText, imageTop float64) int {
	if len(paragraphs) == 0 {
		return 0
	}
	matched, insertion := 0, 0
	for index, paragraph := range paragraphs {
		if top, ok := matchPDFParagraphTop(paragraph, texts); ok {
			matched++
			if top < imageTop {
				insertion = index + 1
			}
		}
	}
	if matched >= 2 || matched == len(paragraphs) {
		return min(len(paragraphs), insertion)
	}
	textBefore := 0
	for _, text := range texts {
		if text.Top+text.Height/2 < imageTop {
			textBefore++
		}
	}
	if len(texts) == 0 {
		return 0
	}
	return min(len(paragraphs), int(math.Round(float64(textBefore)/float64(len(texts))*float64(len(paragraphs)))))
}

func matchPDFParagraphTop(paragraph string, texts []pdfHTMLText) (float64, bool) {
	target := normalizePDFMatchText(paragraph)
	if target == "" {
		return 0, false
	}
	bestScore, bestTop := 0, 0.0
	for _, text := range texts {
		candidate := normalizePDFMatchText(text.Text)
		if candidate == "" {
			continue
		}
		score := commonPDFTextPrefix(target, candidate)
		if score > bestScore {
			bestScore, bestTop = score, text.Top
		}
	}
	return bestTop, bestScore >= min(8, utf8.RuneCountInString(target))
}

func normalizePDFMatchText(value string) string {
	var normalized strings.Builder
	space := false
	for _, char := range strings.ToLower(value) {
		if unicode.IsLetter(char) || unicode.IsDigit(char) {
			if space && normalized.Len() > 0 {
				normalized.WriteByte(' ')
			}
			normalized.WriteRune(char)
			space = false
		} else {
			space = true
		}
	}
	fields := strings.Fields(normalized.String())
	if len(fields) > 1 {
		if _, err := strconv.Atoi(fields[0]); err == nil {
			fields = fields[1:]
		}
	}
	return strings.Join(fields, " ")
}

func commonPDFTextPrefix(left, right string) int {
	leftRunes, rightRunes := []rune(left), []rune(right)
	limit := min(len(leftRunes), len(rightRunes))
	for index := 0; index < limit; index++ {
		if leftRunes[index] != rightRunes[index] {
			return index
		}
	}
	return limit
}

func samePDFImageBounds(left, right pdfTextImage) bool {
	return math.Abs(left.Left-right.Left) < 1 && math.Abs(left.Top-right.Top) < 1 && math.Abs(left.Width-right.Width) < 1 && math.Abs(left.Height-right.Height) < 1
}

func addPDFPageFallbacks(ctx context.Context, filePath, directory string, pages []pdfHTMLPage, paragraphs map[int][]string, images map[int][]pdfTextImage) error {
	for _, page := range pages {
		if page.Width <= 0 || page.Height <= 0 || len(paragraphs[page.Number]) > 0 || len(images[page.Number]) > 0 {
			continue
		}
		visible, err := pdfPageHasVisibleContent(ctx, filePath, directory, page.Number)
		if err != nil {
			if ctx.Err() != nil {
				return ctx.Err()
			}
			log.Printf("detect visual content on pdf page %d: %v", page.Number, err)
			continue
		}
		if !visible {
			continue
		}
		images[page.Number] = []pdfTextImage{{
			ID:         "page",
			Width:      page.Width,
			Height:     page.Height,
			PageWidth:  page.Width,
			PageHeight: page.Height,
		}}
	}
	return nil
}

func pdfPageHasVisibleContent(ctx context.Context, filePath, directory string, page int) (bool, error) {
	prefix := filepath.Join(directory, fmt.Sprintf("preview-%d", page))
	command := exec.CommandContext(ctx, "pdftoppm", "-q", "-cropbox", "-f", strconv.Itoa(page), "-l", strconv.Itoa(page), "-singlefile", "-scale-to", "96", "-png", filePath, prefix)
	if output, err := command.CombinedOutput(); err != nil {
		return false, fmt.Errorf("pdftoppm preview: %w: %s", err, strings.TrimSpace(string(output)))
	}
	file, err := os.Open(prefix + ".png")
	if err != nil {
		return false, err
	}
	defer file.Close()
	preview, err := png.Decode(file)
	if err != nil {
		return false, err
	}
	return hasVisiblePDFContent(preview), nil
}

func hasVisiblePDFContent(preview image.Image) bool {
	bounds := preview.Bounds()
	pixels := bounds.Dx() * bounds.Dy()
	if pixels <= 0 {
		return false
	}
	required := max(6, pixels/1000)
	visible := 0
	for y := bounds.Min.Y; y < bounds.Max.Y; y++ {
		for x := bounds.Min.X; x < bounds.Max.X; x++ {
			red, green, blue, alpha := preview.At(x, y).RGBA()
			if alpha == 0 {
				continue
			}
			luminance := (299*uint64(red) + 587*uint64(green) + 114*uint64(blue)) / 1000
			if luminance < 245*257 {
				visible++
				if visible >= required {
					return true
				}
			}
		}
	}
	return false
}

func splitExtractedPDFText(text string) []string {
	text = strings.ReplaceAll(text, "\r\n", "\n")
	text = strings.ReplaceAll(text, "\r", "\n")
	text = strings.ReplaceAll(text, "\u00a0", " ")
	text = strings.ReplaceAll(text, "\u00ad", "")
	lines := strings.Split(text, "\n")
	stripPDFPageNumber(lines)
	blocks := make([][]string, 0)
	block := make([]string, 0)
	for _, line := range lines {
		if strings.TrimSpace(line) == "" {
			if len(block) > 0 {
				blocks = append(blocks, block)
				block = nil
			}
			continue
		}
		block = append(block, line)
	}
	if len(block) > 0 {
		blocks = append(blocks, block)
	}
	paragraphs := make([]string, 0, len(blocks))
	for _, block := range blocks {
		if shouldPreservePDFLineBreaks(block) {
			if paragraph := preserveExtractedPDFLines(block); paragraph != "" {
				paragraphs = append(paragraphs, paragraph)
			}
			continue
		}
		for _, segment := range splitExtractedPDFBlock(block) {
			paragraph := ""
			for _, line := range segment {
				paragraph = mergeExtractedPDFLine(paragraph, line)
			}
			if paragraph != "" {
				paragraphs = append(paragraphs, paragraph)
			}
		}
	}
	return paragraphs
}

func shouldPreservePDFLineBreaks(lines []string) bool {
	if len(lines) < 2 {
		return false
	}
	dotLeaders := 0
	for _, line := range lines {
		line = strings.TrimSpace(line)
		if strings.Contains(line, ".....") {
			dotLeaders++
		}
	}
	return dotLeaders > 0
}

func preserveExtractedPDFLines(block []string) string {
	lines := make([]string, 0, len(block))
	for _, line := range block {
		line = normalizeExtractedPDFLine(line)
		if line != "" {
			lines = append(lines, line)
		}
	}
	return strings.Join(lines, "\n")
}

func splitExtractedPDFBlock(block []string) [][]string {
	maxLineLength := maxExtractedPDFLineLength(block)
	segments := make([][]string, 0, len(block))
	segment := make([]string, 0, len(block))
	for _, rawLine := range block {
		line := normalizeExtractedPDFLine(rawLine)
		if line == "" {
			continue
		}
		if len(segment) > 0 && startsNewExtractedPDFSegment(segment[len(segment)-1], rawLine, maxLineLength) {
			segments = append(segments, segment)
			segment = nil
		}
		segment = append(segment, line)
	}
	if len(segment) > 0 {
		segments = append(segments, segment)
	}
	return segments
}

func startsNewExtractedPDFSegment(previous, rawLine string, maxLineLength int) bool {
	line := strings.TrimSpace(rawLine)
	if line == "" {
		return false
	}
	if isPDFListLine(line) {
		return true
	}
	if strings.HasPrefix(previous, "• ") {
		return false
	}
	if strings.HasSuffix(previous, "-") && startsWithLowercase(line) {
		return false
	}
	if !endsExtractedPDFParagraph(previous) {
		return false
	}
	if maxLineLength > 0 && utf8.RuneCountInString(previous) > maxLineLength*2/3 {
		return false
	}
	return startsWithUppercase(line)
}

func normalizeExtractedPDFLine(line string) string {
	line = strings.ReplaceAll(line, "\u00a0", " ")
	line = strings.ReplaceAll(line, "\u00ad", "")
	line = strings.TrimSpace(line)
	if line == "" {
		return ""
	}
	if rest, ok := trimPDFBulletPrefix(line); ok {
		rest = strings.Join(strings.Fields(rest), " ")
		if rest == "" {
			return "•"
		}
		return "• " + rest
	}
	return strings.Join(strings.Fields(line), " ")
}

func maxExtractedPDFLineLength(lines []string) int {
	maximum := 0
	for _, line := range lines {
		line = normalizeExtractedPDFLine(line)
		if line == "" {
			continue
		}
		if length := utf8.RuneCountInString(line); length > maximum {
			maximum = length
		}
	}
	return maximum
}

func endsExtractedPDFParagraph(line string) bool {
	line = strings.TrimSpace(line)
	if line == "" {
		return false
	}
	line = strings.TrimRight(line, "»”')]} ")
	if line == "" {
		return false
	}
	r, _ := utf8.DecodeLastRuneInString(line)
	switch r {
	case '.', '!', '?', ':', ';', '…':
		return true
	default:
		return false
	}
}

func startsWithUppercase(value string) bool {
	value = strings.TrimLeft(value, " \t\n\r«“\"'([—–-•")
	r, _ := utf8.DecodeRuneInString(value)
	return r != utf8.RuneError && (unicode.IsUpper(r) || unicode.IsDigit(r))
}

func isPDFListLine(line string) bool {
	if line == "" {
		return false
	}
	if _, ok := trimPDFBulletPrefix(line); ok {
		return true
	}
	first, _, _ := strings.Cut(line, " ")
	first = strings.TrimRight(first, ".)")
	parts := strings.Split(first, ".")
	if len(parts) > 4 {
		return false
	}
	for _, part := range parts {
		if part == "" {
			return false
		}
		if _, err := strconv.Atoi(part); err != nil {
			return false
		}
	}
	return true
}

func trimPDFBulletPrefix(line string) (string, bool) {
	line = strings.TrimSpace(line)
	if line == "" {
		return "", false
	}
	matched := false
	for line != "" {
		r, size := utf8.DecodeRuneInString(line)
		if r == utf8.RuneError && size == 0 {
			break
		}
		if !isPDFBulletRune(r) {
			break
		}
		line = line[size:]
		matched = true
	}
	if matched {
		return strings.TrimSpace(line), true
	}
	for _, prefix := range []string{"– ", "— ", "- "} {
		if strings.HasPrefix(line, prefix) {
			return strings.TrimSpace(strings.TrimPrefix(line, prefix)), true
		}
	}
	return "", false
}

func isPDFBulletRune(r rune) bool {
	switch r {
	case '\u0089', '•', '‣', '⁃', '◦', '○', '●', '▪', '▫', '■', '□', '▢', '◻', '◽', '☐':
		return true
	default:
		return false
	}
}

func stripPDFPageNumber(lines []string) {
	first, last := -1, -1
	for index, line := range lines {
		if strings.TrimSpace(line) == "" {
			continue
		}
		if first < 0 {
			first = index
		}
		last = index
	}
	if first >= 0 && isPDFPageNumber(lines[first]) {
		lines[first] = ""
	}
	if last >= 0 && last != first && isPDFPageNumber(lines[last]) {
		lines[last] = ""
	}
}

func isPDFPageNumber(line string) bool {
	line = strings.TrimSpace(strings.Trim(line, "-–—"))
	if line == "" {
		return false
	}
	_, err := strconv.Atoi(strings.TrimSpace(line))
	return err == nil
}

func mergeExtractedPDFLine(paragraph, line string) string {
	if paragraph == "" {
		return strings.Join(strings.Fields(line), " ")
	}
	line = strings.Join(strings.Fields(line), " ")
	if strings.HasSuffix(paragraph, "-") && startsWithLowercase(line) {
		return strings.TrimSuffix(paragraph, "-") + line
	}
	if strings.HasSuffix(paragraph, "«") || strings.HasSuffix(paragraph, "“") || strings.HasSuffix(paragraph, "(") {
		return paragraph + line
	}
	if strings.HasPrefix(line, ".") || strings.HasPrefix(line, ",") || strings.HasPrefix(line, ";") || strings.HasPrefix(line, ":") || strings.HasPrefix(line, "!") || strings.HasPrefix(line, "?") || strings.HasPrefix(line, "»") || strings.HasPrefix(line, "”") || strings.HasPrefix(line, ")") {
		return paragraph + line
	}
	return paragraph + " " + line
}

func startsWithLowercase(value string) bool {
	r, _ := utf8.DecodeRuneInString(strings.TrimSpace(value))
	return r != utf8.RuneError && unicode.IsLower(r)
}

func newPDFTextCache() pdfTextCache {
	return pdfTextCache{Version: pdfTextCacheVersion, Pages: make(map[int]pdfTextPageCache)}
}

func (a *App) pdfTextCachePath(bookID string) string {
	return filepath.Join(a.dataDir, pdfTextDirectory, bookID+".json")
}

func (a *App) pdfImageBookDirectory(bookID string) string {
	return filepath.Join(a.dataDir, pdfImageDirectory, bookID)
}

func (a *App) pdfImageCachePath(bookID string, page int, imageID string) string {
	return filepath.Join(a.pdfImageBookDirectory(bookID), fmt.Sprintf("%d-%s.png", page, imageID))
}

func (a *App) loadPDFTextCache(bookID string) (pdfTextCache, error) {
	data, err := os.ReadFile(a.pdfTextCachePath(bookID))
	if errors.Is(err, os.ErrNotExist) {
		return newPDFTextCache(), nil
	}
	if err != nil {
		return pdfTextCache{}, err
	}
	var cache pdfTextCache
	if err := json.Unmarshal(data, &cache); err != nil {
		return pdfTextCache{}, err
	}
	if cache.Version != pdfTextCacheVersion || cache.Pages == nil {
		return newPDFTextCache(), nil
	}
	return cache, nil
}

func (a *App) savePDFTextCache(bookID string, cache pdfTextCache) error {
	data, err := json.Marshal(cache)
	if err != nil {
		return err
	}
	directory := filepath.Join(a.dataDir, pdfTextDirectory)
	temporary, err := os.CreateTemp(directory, ".pdf-text-*")
	if err != nil {
		return err
	}
	name := temporary.Name()
	defer os.Remove(name)
	if err := temporary.Chmod(0o600); err != nil {
		temporary.Close()
		return err
	}
	if _, err := temporary.Write(data); err != nil {
		temporary.Close()
		return err
	}
	if err := temporary.Close(); err != nil {
		return err
	}
	return os.Rename(name, a.pdfTextCachePath(bookID))
}

func pdfPageCount(ctx context.Context, filePath string) (int, error) {
	ctx, cancel := context.WithTimeout(ctx, 8*time.Second)
	defer cancel()
	output, err := exec.CommandContext(ctx, "pdfinfo", filePath).Output()
	if err != nil {
		return 0, err
	}
	for _, line := range strings.Split(string(output), "\n") {
		name, value, found := strings.Cut(line, ":")
		if !found || !strings.EqualFold(strings.TrimSpace(name), "Pages") {
			continue
		}
		pages, err := strconv.Atoi(strings.TrimSpace(value))
		if err == nil && pages > 0 {
			return pages, nil
		}
	}
	return 0, errors.New("pdf page count not found")
}

func (a *App) rememberPDFPageCount(bookID string, pages int) {
	a.mu.Lock()
	defer a.mu.Unlock()
	book, exists := a.state.Books[bookID]
	if !exists || book.Pages == pages {
		return
	}
	book.Pages = pages
	a.state.Books[bookID] = book
	if err := a.persistLocked(); err != nil {
		log.Printf("persist pdf page count: %v", err)
	}
}

func queryInt(r *http.Request, name string, fallback int) int {
	value := strings.TrimSpace(r.URL.Query().Get(name))
	if value == "" {
		return fallback
	}
	number, err := strconv.Atoi(value)
	if err != nil {
		return fallback
	}
	return number
}

func (a *App) frontend(w http.ResponseWriter, r *http.Request) {
	if strings.HasPrefix(r.URL.Path, "/api/") {
		writeError(w, http.StatusNotFound, "Маршрут не найден")
		return
	}
	if a.webDir == "" {
		writeError(w, http.StatusNotFound, "Frontend не собран")
		return
	}
	relativePath := strings.TrimPrefix(filepath.Clean("/"+r.URL.Path), "/")
	requested := filepath.Join(a.webDir, relativePath)
	if info, err := os.Stat(requested); err == nil && !info.IsDir() {
		if strings.HasPrefix(relativePath, "assets/") {
			w.Header().Set("Cache-Control", "public, max-age=31536000, immutable")
		} else {
			setFrontendNoCacheHeaders(w)
		}
		http.ServeFile(w, r, requested)
		return
	}
	setFrontendNoCacheHeaders(w)
	http.ServeFile(w, r, filepath.Join(a.webDir, "index.html"))
}

func setFrontendNoCacheHeaders(w http.ResponseWriter) {
	w.Header().Set("Cache-Control", "no-store, no-cache, must-revalidate")
	w.Header().Set("Pragma", "no-cache")
	w.Header().Set("Expires", "0")
}

func (a *App) authenticate(r *http.Request) (string, string, bool) {
	header := r.Header.Get("Authorization")
	if !strings.HasPrefix(header, "Bearer ") {
		return "", "", false
	}
	token := strings.TrimSpace(strings.TrimPrefix(header, "Bearer "))
	a.mu.RLock()
	session, exists := a.state.Sessions[token]
	a.mu.RUnlock()
	if !exists || time.Now().After(session.ExpiresAt) {
		return "", "", false
	}
	return session.UserID, token, true
}

func (a *App) createUserAndSession(user User) (string, error) {
	a.mu.Lock()
	defer a.mu.Unlock()
	for _, existing := range a.state.Users {
		if existing.Email == user.Email {
			return "", errConflict
		}
	}
	token := randomToken()
	a.state.Users[user.ID] = user
	a.state.Sessions[token] = Session{UserID: user.ID, ExpiresAt: time.Now().Add(sessionLifetime).UTC()}
	if err := a.persistLocked(); err != nil {
		delete(a.state.Users, user.ID)
		delete(a.state.Sessions, token)
		return "", err
	}
	return token, nil
}

func (a *App) createSession(userID string) (string, error) {
	a.mu.Lock()
	defer a.mu.Unlock()
	token := randomToken()
	a.state.Sessions[token] = Session{UserID: userID, ExpiresAt: time.Now().Add(sessionLifetime).UTC()}
	if err := a.persistLocked(); err != nil {
		delete(a.state.Sessions, token)
		return "", err
	}
	return token, nil
}

func (a *App) userByEmail(email string) (User, bool) {
	a.mu.RLock()
	defer a.mu.RUnlock()
	for _, user := range a.state.Users {
		if user.Email == email {
			return user, true
		}
	}
	return User{}, false
}

func (a *App) load() error {
	data, err := os.ReadFile(filepath.Join(a.dataDir, stateFileName))
	if errors.Is(err, os.ErrNotExist) {
		return nil
	}
	if err != nil {
		return fmt.Errorf("read state: %w", err)
	}
	var stored diskState
	if err := json.Unmarshal(data, &stored); err != nil {
		return fmt.Errorf("decode state: %w", err)
	}
	a.state.Users = stored.Users
	a.state.Sessions = stored.Sessions
	a.state.Books = make(map[string]Book, len(stored.Books))
	for id, value := range stored.Books {
		book := value.Book
		book.UserID = value.UserID
		book.StoredName = value.StoredName
		a.state.Books[id] = book
	}
	if a.state.Users == nil {
		a.state.Users = make(map[string]User)
	}
	if a.state.Books == nil {
		a.state.Books = make(map[string]Book)
	}
	if a.state.Sessions == nil {
		a.state.Sessions = make(map[string]Session)
	}
	return nil
}

func (a *App) persistLocked() error {
	stored := diskState{
		Users: a.state.Users, Sessions: a.state.Sessions,
		Books: make(map[string]diskBook, len(a.state.Books)),
	}
	for id, book := range a.state.Books {
		stored.Books[id] = diskBook{Book: book, UserID: book.UserID, StoredName: book.StoredName}
	}
	data, err := json.MarshalIndent(stored, "", "  ")
	if err != nil {
		return err
	}
	temporary, err := os.CreateTemp(a.dataDir, ".state-*")
	if err != nil {
		return err
	}
	name := temporary.Name()
	defer os.Remove(name)
	if err := temporary.Chmod(0o600); err != nil {
		temporary.Close()
		return err
	}
	if _, err := temporary.Write(data); err != nil {
		temporary.Close()
		return err
	}
	if err := temporary.Sync(); err != nil {
		temporary.Close()
		return err
	}
	if err := temporary.Close(); err != nil {
		return err
	}
	return os.Rename(name, filepath.Join(a.dataDir, stateFileName))
}

func publicUser(user User) PublicUser {
	return PublicUser{ID: user.ID, Name: user.Name, Email: user.Email, CreatedAt: user.CreatedAt}
}

func derivePassword(password string, salt []byte) []byte {
	block := make([]byte, len(salt)+4)
	copy(block, salt)
	block[len(block)-1] = 1
	u := hmacSHA256([]byte(password), block)
	result := append([]byte(nil), u...)
	for i := 1; i < passwordRounds; i++ {
		u = hmacSHA256([]byte(password), u)
		for j := range result {
			result[j] ^= u[j]
		}
	}
	return result
}

func hmacSHA256(key, data []byte) []byte {
	h := hmac.New(sha256.New, key)
	h.Write(data)
	return h.Sum(nil)
}

func passwordMatches(password, encodedSalt, encodedHash string) bool {
	salt, saltErr := base64.RawStdEncoding.DecodeString(encodedSalt)
	want, hashErr := base64.RawStdEncoding.DecodeString(encodedHash)
	if saltErr != nil || hashErr != nil {
		return false
	}
	got := derivePassword(password, salt)
	return len(got) == len(want) && subtle.ConstantTimeCompare(got, want) == 1
}

func randomID(bytes int) string {
	value := make([]byte, bytes)
	if _, err := rand.Read(value); err != nil {
		panic(err)
	}
	return hex.EncodeToString(value)
}

func randomToken() string {
	value := make([]byte, 32)
	if _, err := rand.Read(value); err != nil {
		panic(err)
	}
	return base64.RawURLEncoding.EncodeToString(value)
}

func readJSON(r *http.Request, target any) error {
	defer r.Body.Close()
	decoder := json.NewDecoder(io.LimitReader(r.Body, 1<<20))
	decoder.DisallowUnknownFields()
	return decoder.Decode(target)
}

func writeJSON(w http.ResponseWriter, status int, value any) {
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.WriteHeader(status)
	if err := json.NewEncoder(w).Encode(value); err != nil {
		log.Printf("write response: %v", err)
	}
}

func writeError(w http.ResponseWriter, status int, message string) {
	writeJSON(w, status, map[string]string{"error": message})
}

func ParsePort(value string, fallback int) int {
	port, err := strconv.Atoi(value)
	if err != nil || port < 1 || port > 65535 {
		return fallback
	}
	return port
}
