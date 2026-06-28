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
	"errors"
	"fmt"
	"io"
	"log"
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
	pdfTextCacheVersion = 2
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
	ID           string    `json:"id"`
	UserID       string    `json:"-"`
	Title        string    `json:"title"`
	Author       string    `json:"author"`
	Format       string    `json:"format"`
	OriginalName string    `json:"originalName"`
	StoredName   string    `json:"-"`
	Size         int64     `json:"size"`
	Progress     float64   `json:"progress"`
	Location     string    `json:"location,omitempty"`
	Page         int       `json:"page,omitempty"`
	Pages        int       `json:"pages,omitempty"`
	Favorite     bool      `json:"favorite"`
	CreatedAt    time.Time `json:"createdAt"`
	UpdatedAt    time.Time `json:"updatedAt"`
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
	Title    *string  `json:"title"`
	Author   *string  `json:"author"`
	Progress *float64 `json:"progress"`
	Location *string  `json:"location"`
	Page     *int     `json:"page"`
	Pages    *int     `json:"pages"`
	Favorite *bool    `json:"favorite"`
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
	Page       int      `json:"page"`
	Paragraphs []string `json:"paragraphs"`
}

type pdfTextCache struct {
	Version int              `json:"version"`
	Pages   map[int][]string `json:"pages"`
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
				cache.Pages[page.Page] = page.Paragraphs
			}
			if err := a.savePDFTextCache(bookID, cache); err != nil {
				extractionErr = fmt.Errorf("save cache: %w", err)
			}
		}
	}

	pages := make([]pdfTextPage, 0, to-from+1)
	for page := from; page <= to; page++ {
		pages = append(pages, pdfTextPage{Page: page, Paragraphs: cache.Pages[page]})
	}
	return pages, extractionErr
}

func extractPDFTextPages(ctx context.Context, filePath string, from, to int) ([]pdfTextPage, error) {
	timeout := 8*time.Second + time.Duration(to-from)*time.Second
	ctx, cancel := context.WithTimeout(ctx, min(30*time.Second, timeout))
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
	return pages, nil
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
		paragraph := ""
		for _, line := range block {
			line = strings.TrimSpace(line)
			paragraph = mergeExtractedPDFLine(paragraph, line)
		}
		if paragraph != "" {
			paragraphs = append(paragraphs, paragraph)
		}
	}
	return paragraphs
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
	return pdfTextCache{Version: pdfTextCacheVersion, Pages: make(map[int][]string)}
}

func (a *App) pdfTextCachePath(bookID string) string {
	return filepath.Join(a.dataDir, pdfTextDirectory, bookID+".json")
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
		http.ServeFile(w, r, requested)
		return
	}
	http.ServeFile(w, r, filepath.Join(a.webDir, "index.html"))
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
