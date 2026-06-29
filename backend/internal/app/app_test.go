package app

import (
	"bytes"
	"encoding/json"
	"io"
	"mime/multipart"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

func TestSplitExtractedPDFText(t *testing.T) {
	text := "  12  \n\nЗаголовок\n\nПервая длин-\nная строка.\n\n1\nПункт списка\n\n— 13 —\n"
	want := []string{"Заголовок", "Первая длинная строка.", "1 Пункт списка"}
	got := splitExtractedPDFText(text)
	if len(got) != len(want) {
		t.Fatalf("paragraphs = %#v, want %#v", got, want)
	}
	for index := range want {
		if got[index] != want[index] {
			t.Fatalf("paragraph %d = %q, want %q", index, got[index], want[index])
		}
	}
}

func TestSplitExtractedPDFTextPreservesContentsLines(t *testing.T) {
	text := "Оглавление\n\nПредисловие................................14\nКому стоит прочесть эту книгу..............16\n1.2. Надёжность............................27\n"
	want := []string{
		"Оглавление",
		"Предисловие................................14\nКому стоит прочесть эту книгу..............16\n1.2. Надёжность............................27",
	}
	got := splitExtractedPDFText(text)
	if len(got) != len(want) {
		t.Fatalf("paragraphs = %#v, want %#v", got, want)
	}
	for index := range want {
		if got[index] != want[index] {
			t.Fatalf("paragraph %d = %q, want %q", index, got[index], want[index])
		}
	}
}

func TestSplitExtractedPDFTextKeepsParagraphAndListBreaks(t *testing.T) {
	text := "Предисловие\n\nЕсли вам приходилось работать с серверными системами,\nто вас заваливали модными словечками. NoSQL!\nБольшие данные! В режиме реального\nвремени!\nЗа последнее десятилетие мы увидели нововведения\nи усовершенствования.\n\u0089\u0089Такие интернет-компании, как Google, Yahoo!, Amazon,\n  Microsoft и Twitter, обрабатывают большие объемы данных,\n  что вынуждает их создавать новые инструменты.\n\u0089\u0089Коммерческим компаниям приходится проверять гипотезы\n  с минимальными затратами и быстро реагировать.\n"
	want := []string{
		"Предисловие",
		"Если вам приходилось работать с серверными системами, то вас заваливали модными словечками. NoSQL! Большие данные! В режиме реального времени!",
		"За последнее десятилетие мы увидели нововведения и усовершенствования.",
		"• Такие интернет-компании, как Google, Yahoo!, Amazon, Microsoft и Twitter, обрабатывают большие объемы данных, что вынуждает их создавать новые инструменты.",
		"• Коммерческим компаниям приходится проверять гипотезы с минимальными затратами и быстро реагировать.",
	}
	got := splitExtractedPDFText(text)
	if len(got) != len(want) {
		t.Fatalf("paragraphs = %#v, want %#v", got, want)
	}
	for index := range want {
		if got[index] != want[index] {
			t.Fatalf("paragraph %d = %q, want %q", index, got[index], want[index])
		}
	}
}

func TestPDFTextCacheRoundTrip(t *testing.T) {
	handler, err := New(t.TempDir(), "")
	if err != nil {
		t.Fatal(err)
	}
	cache := newPDFTextCache()
	cache.Pages[7] = []string{"Сохранённый текст"}
	if err := handler.savePDFTextCache("book-id", cache); err != nil {
		t.Fatal(err)
	}
	loaded, err := handler.loadPDFTextCache("book-id")
	if err != nil {
		t.Fatal(err)
	}
	if len(loaded.Pages[7]) != 1 || loaded.Pages[7][0] != "Сохранённый текст" {
		t.Fatalf("cache was not restored: %#v", loaded)
	}
}

func TestAccountBookAndProgressFlow(t *testing.T) {
	handler, err := New(t.TempDir(), "")
	if err != nil {
		t.Fatal(err)
	}
	token := registerTestUser(t, handler, "reader@example.com")

	var body bytes.Buffer
	writer := multipart.NewWriter(&body)
	part, err := writer.CreateFormFile("file", "example.fb2")
	if err != nil {
		t.Fatal(err)
	}
	fileContent := []byte("<?xml version=\"1.0\"?><FictionBook><body><section><p>Текст</p></section></body></FictionBook>")
	if _, err := part.Write(fileContent); err != nil {
		t.Fatal(err)
	}
	if err := writer.WriteField("title", "Тестовая книга"); err != nil {
		t.Fatal(err)
	}
	if err := writer.Close(); err != nil {
		t.Fatal(err)
	}

	upload := httptest.NewRequest(http.MethodPost, "/api/books", &body)
	upload.Header.Set("Content-Type", writer.FormDataContentType())
	upload.Header.Set("Authorization", "Bearer "+token)
	uploadResponse := httptest.NewRecorder()
	handler.ServeHTTP(uploadResponse, upload)
	if uploadResponse.Code != http.StatusCreated {
		t.Fatalf("upload status = %d, body = %s", uploadResponse.Code, uploadResponse.Body.String())
	}
	var book Book
	if err := json.Unmarshal(uploadResponse.Body.Bytes(), &book); err != nil {
		t.Fatal(err)
	}
	if book.Title != "Тестовая книга" || book.Format != "FB2" {
		t.Fatalf("unexpected book: %#v", book)
	}

	patch := authenticatedRequest(http.MethodPatch, "/api/books/"+book.ID, `{"progress":100,"page":12,"favorite":true,"finishedAt":"2026-06-29T10:00:00Z"}`, token)
	patchResponse := httptest.NewRecorder()
	handler.ServeHTTP(patchResponse, patch)
	if patchResponse.Code != http.StatusOK {
		t.Fatalf("patch status = %d, body = %s", patchResponse.Code, patchResponse.Body.String())
	}
	if err := json.Unmarshal(patchResponse.Body.Bytes(), &book); err != nil {
		t.Fatal(err)
	}
	if book.Progress != 100 || book.Page != 12 || !book.Favorite || book.FinishedAt == nil {
		t.Fatalf("progress not persisted: %#v", book)
	}

	fileRequest := authenticatedRequest(http.MethodGet, "/api/books/"+book.ID+"/file", "", token)
	fileResponse := httptest.NewRecorder()
	handler.ServeHTTP(fileResponse, fileRequest)
	if fileResponse.Code != http.StatusOK {
		t.Fatalf("file status = %d", fileResponse.Code)
	}
	if !bytes.Equal(fileResponse.Body.Bytes(), fileContent) {
		t.Fatal("downloaded file differs from uploaded file")
	}

	secondToken := registerTestUser(t, handler, "other@example.com")
	forbidden := authenticatedRequest(http.MethodGet, "/api/books/"+book.ID+"/file", "", secondToken)
	forbiddenResponse := httptest.NewRecorder()
	handler.ServeHTTP(forbiddenResponse, forbidden)
	if forbiddenResponse.Code != http.StatusNotFound {
		t.Fatalf("other user file status = %d", forbiddenResponse.Code)
	}
}

func TestLoginAndDuplicateRegistration(t *testing.T) {
	handler, err := New(t.TempDir(), "")
	if err != nil {
		t.Fatal(err)
	}
	registerTestUser(t, handler, "reader@example.com")

	duplicate := httptest.NewRequest(http.MethodPost, "/api/auth/register", strings.NewReader(`{"name":"Reader","email":"reader@example.com","password":"password123"}`))
	duplicate.Header.Set("Content-Type", "application/json")
	duplicateResponse := httptest.NewRecorder()
	handler.ServeHTTP(duplicateResponse, duplicate)
	if duplicateResponse.Code != http.StatusConflict {
		t.Fatalf("duplicate status = %d", duplicateResponse.Code)
	}

	login := httptest.NewRequest(http.MethodPost, "/api/auth/login", strings.NewReader(`{"email":"reader@example.com","password":"password123"}`))
	login.Header.Set("Content-Type", "application/json")
	loginResponse := httptest.NewRecorder()
	handler.ServeHTTP(loginResponse, login)
	if loginResponse.Code != http.StatusOK {
		t.Fatalf("login status = %d, body = %s", loginResponse.Code, loginResponse.Body.String())
	}
	var payload struct {
		Token string `json:"token"`
	}
	if err := json.NewDecoder(loginResponse.Body).Decode(&payload); err != nil {
		t.Fatal(err)
	}
	if payload.Token == "" {
		t.Fatal("empty login token")
	}
}

func TestBooksSurviveRestart(t *testing.T) {
	dataDir := t.TempDir()
	handler, err := New(dataDir, "")
	if err != nil {
		t.Fatal(err)
	}
	token := registerTestUser(t, handler, "reader@example.com")

	var body bytes.Buffer
	writer := multipart.NewWriter(&body)
	part, _ := writer.CreateFormFile("file", "restart.pdf")
	_, _ = part.Write([]byte("%PDF-test"))
	_ = writer.Close()
	request := httptest.NewRequest(http.MethodPost, "/api/books", &body)
	request.Header.Set("Content-Type", writer.FormDataContentType())
	request.Header.Set("Authorization", "Bearer "+token)
	response := httptest.NewRecorder()
	handler.ServeHTTP(response, request)
	if response.Code != http.StatusCreated {
		t.Fatalf("upload status = %d, body = %s", response.Code, response.Body.String())
	}
	var uploaded Book
	if err := json.Unmarshal(response.Body.Bytes(), &uploaded); err != nil {
		t.Fatal(err)
	}
	finish := authenticatedRequest(http.MethodPatch, "/api/books/"+uploaded.ID, `{"progress":100,"finishedAt":"2026-06-29T10:00:00Z"}`, token)
	finishResponse := httptest.NewRecorder()
	handler.ServeHTTP(finishResponse, finish)
	if finishResponse.Code != http.StatusOK {
		t.Fatalf("finish status = %d, body = %s", finishResponse.Code, finishResponse.Body.String())
	}

	restarted, err := New(dataDir, "")
	if err != nil {
		t.Fatal(err)
	}
	list := authenticatedRequest(http.MethodGet, "/api/books", "", token)
	listResponse := httptest.NewRecorder()
	restarted.ServeHTTP(listResponse, list)
	if listResponse.Code != http.StatusOK {
		t.Fatalf("list after restart status = %d", listResponse.Code)
	}
	var books []Book
	if err := json.NewDecoder(listResponse.Body).Decode(&books); err != nil {
		t.Fatal(err)
	}
	if len(books) != 1 {
		t.Fatalf("book was not restored: %#v", books)
	}
	restored := restarted.state.Books[books[0].ID]
	if restored.StoredName == "" || restored.UserID == "" || restored.FinishedAt == nil {
		t.Fatalf("private book data was not restored: %#v", restored)
	}
}

func registerTestUser(t *testing.T, handler http.Handler, email string) string {
	t.Helper()
	request := httptest.NewRequest(http.MethodPost, "/api/auth/register", strings.NewReader(`{"name":"Reader","email":"`+email+`","password":"password123"}`))
	request.Header.Set("Content-Type", "application/json")
	response := httptest.NewRecorder()
	handler.ServeHTTP(response, request)
	if response.Code != http.StatusCreated {
		t.Fatalf("register status = %d, body = %s", response.Code, response.Body.String())
	}
	var payload struct {
		Token string `json:"token"`
	}
	if err := json.NewDecoder(response.Body).Decode(&payload); err != nil {
		t.Fatal(err)
	}
	return payload.Token
}

func authenticatedRequest(method, target, body, token string) *http.Request {
	var reader io.Reader
	if body != "" {
		reader = strings.NewReader(body)
	}
	request := httptest.NewRequest(method, target, reader)
	request.Header.Set("Authorization", "Bearer "+token)
	if body != "" {
		request.Header.Set("Content-Type", "application/json")
	}
	return request
}
