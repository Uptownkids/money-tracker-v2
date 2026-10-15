/**
 * Theme plumbing. The `dark` class on <html> drives Tailwind's
 * `@custom-variant dark` styles. "system" follows the OS setting live.
 */
export type ThemeSetting = "system" | "light" | "dark";
export type ResolvedTheme = "light" | "dark";

/** Map a setting to light/dark; "system" reads prefers-color-scheme. */
export function resolveTheme(theme: ThemeSetting): ResolvedTheme {
  if (theme === "light" || theme === "dark") return theme;
  if (typeof window === "undefined" || typeof window.matchMedia !== "function") {
    return "light";
  }
  return window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
}

/** Apply the theme by toggling the `dark` class on <html>. */
export function applyTheme(theme: ThemeSetting): void {
  if (typeof document === "undefined") return;
  document.documentElement.classList.toggle("dark", resolveTheme(theme) === "dark");
}

/**
 * Re-run `onChange` whenever the OS color scheme flips. Returns an
 * unsubscribe. The caller decides what to do (usually re-applyTheme when
 * the setting is "system").
 */
export function watchSystemTheme(onChange: () => void): () => void {
  if (typeof window === "undefined" || typeof window.matchMedia !== "function") {
    return () => {};
  }
  const mq = window.matchMedia("(prefers-color-scheme: dark)");
  const handler = (): void => onChange();
  mq.addEventListener("change", handler);
  return () => mq.removeEventListener("change", handler);
}
