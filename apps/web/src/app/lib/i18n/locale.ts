export type Locale = "en" | "fr";

export const localeCookieName = "checkout-surge-locale";

/**
 * The language the visitor picked with the switcher, or else the one their browser prefers
 * between the supported ones (its `Accept-Language` header). English when neither says.
 */
export function resolveLocale(
  savedValue: string | undefined,
  acceptLanguage: string | null,
): Locale {
  if (savedValue === "en" || savedValue === "fr") return savedValue;
  return browserLocale(acceptLanguage);
}

function browserLocale(acceptLanguage: string | null): Locale {
  const ranked = (acceptLanguage ?? "")
    .split(",")
    .map((entry) => {
      const [tag = "", ...parameters] = entry.split(";").map((part) => part.trim());
      const quality = parameters.find((parameter) => parameter.startsWith("q="));
      return {
        language: tag.toLowerCase().split("-")[0],
        quality: quality === undefined ? 1 : Number(quality.slice(2)),
      };
    })
    .filter(({ language, quality }) => (language === "en" || language === "fr") && quality > 0)
    .sort((a, b) => b.quality - a.quality);
  return ranked[0]?.language === "fr" ? "fr" : "en";
}

export function intlLocale(locale: Locale): string {
  return locale === "fr" ? "fr-FR" : "en-US";
}
