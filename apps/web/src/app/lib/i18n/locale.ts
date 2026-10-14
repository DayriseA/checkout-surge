export type Locale = "en" | "fr";

export const localeCookieName = "checkout-surge-locale";

export function resolveLocale(value: string | undefined): Locale {
  return value === "fr" ? "fr" : "en";
}

export function intlLocale(locale: Locale): string {
  return locale === "fr" ? "fr-FR" : "en-US";
}
