"use client";

import { useRouter } from "next/navigation";
import { localeCookieName } from "../lib/i18n/locale";
import { useLocale, useTranslation } from "../lib/i18n/locale-context";

export function LanguageSwitcher() {
  const locale = useLocale();
  const t = useTranslation();
  const router = useRouter();
  const nextLocale = locale === "en" ? "fr" : "en";
  const label = t(locale === "en" ? "Switch to French" : "Switch to English");

  function switchLanguage() {
    const secure = window.location.protocol === "https:" ? "; Secure" : "";
    // biome-ignore lint/suspicious/noDocumentCookie: The preference must also work in browsers without the Cookie Store API.
    document.cookie = `${localeCookieName}=${nextLocale}; Path=/; Max-Age=31536000; SameSite=Lax${secure}`;
    router.refresh();
  }

  return (
    <button
      aria-label={label}
      className="inline-flex min-h-11 items-center gap-1.5 rounded-md px-2 py-2 text-sm font-medium text-white/80 hover:bg-reservoir-raised hover:text-white focus-visible:outline-signal"
      onClick={switchLanguage}
      title={label}
      type="button"
    >
      <svg
        aria-hidden="true"
        className="size-4"
        fill="none"
        viewBox="0 0 24 24"
        stroke="currentColor"
        strokeWidth="1.5"
      >
        <circle cx="12" cy="12" r="9" />
        <ellipse cx="12" cy="12" rx="4" ry="9" />
        <path d="M3 12h18M5 7h14M5 17h14" />
      </svg>
      <span lang={nextLocale}>{nextLocale.toUpperCase()}</span>
    </button>
  );
}
