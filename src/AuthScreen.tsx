import { useState, type FormEvent } from "react";
import { api } from "./api";
import { LibraryIcon } from "./icons";
import type { User } from "./types";

interface AuthScreenProps {
  onAuthenticated: (user: User) => void;
}

export function AuthScreen({ onAuthenticated }: AuthScreenProps) {
  const [mode, setMode] = useState<"login" | "register">("login");
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [submitting, setSubmitting] = useState(false);

  async function submit(event: FormEvent) {
    event.preventDefault();
    setError("");
    setSubmitting(true);
    try {
      const payload = mode === "register"
        ? await api.register(name, email, password)
        : await api.login(email, password);
      api.saveToken(payload.token);
      onAuthenticated(payload.user);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Не удалось войти");
    } finally {
      setSubmitting(false);
    }
  }

  function switchMode(nextMode: "login" | "register") {
    setMode(nextMode);
    setError("");
  }

  return (
    <main className="auth-page">
      <section className="auth-presentation">
        <div className="brand auth-brand"><span className="brand-mark"/><span>Полка</span></div>
        <div className="auth-message">
          <p className="eyebrow">Личная библиотека</p>
          <h1>Читайте там,<br/>где остановились</h1>
          <p>PDF, EPUB и FB2 в одной аккуратной библиотеке. Прогресс синхронизируется между компьютером и телефоном.</p>
        </div>
        <div className="auth-feature"><LibraryIcon/><span><strong>Ваши книги — только ваши</strong>Файлы доступны после входа в аккаунт.</span></div>
      </section>
      <section className="auth-form-side">
        <form className="auth-form" onSubmit={submit}>
          <p className="eyebrow">{mode === "login" ? "С возвращением" : "Новый аккаунт"}</p>
          <h2>{mode === "login" ? "Войти в Полку" : "Создать свою Полку"}</h2>
          <p className="auth-intro">{mode === "login" ? "Продолжите читать с сохранённого места." : "Библиотека будет доступна на всех ваших устройствах."}</p>
          {mode === "register" && (
            <label className="field"><span>Имя</span><input value={name} onChange={event => setName(event.target.value)} autoComplete="name" required placeholder="Как к вам обращаться"/></label>
          )}
          <label className="field"><span>Электронная почта</span><input value={email} onChange={event => setEmail(event.target.value)} type="email" autoComplete="email" required placeholder="name@example.ru"/></label>
          <label className="field"><span>Пароль</span><input value={password} onChange={event => setPassword(event.target.value)} type="password" minLength={8} autoComplete={mode === "login" ? "current-password" : "new-password"} required placeholder="Не менее 8 символов"/></label>
          {error && <div className="form-error" role="alert">{error}</div>}
          <button className="primary-button auth-submit" disabled={submitting}>{submitting ? "Подождите…" : mode === "login" ? "Войти" : "Создать аккаунт"}</button>
          <p className="auth-switch">
            {mode === "login" ? "Нет аккаунта?" : "Уже есть аккаунт?"}
            <button type="button" onClick={() => switchMode(mode === "login" ? "register" : "login")}>{mode === "login" ? "Зарегистрироваться" : "Войти"}</button>
          </p>
        </form>
      </section>
    </main>
  );
}
