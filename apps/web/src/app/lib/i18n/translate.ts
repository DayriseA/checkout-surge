import { historyMessages } from "./history-messages";
import type { Locale } from "./locale";
import { pageMessages } from "./page-messages";
import { rootMessages } from "./root-messages";
import { signalMessages } from "./signal-messages";

export type { Locale } from "./locale";
export type TranslationValues = Record<string, string | number>;
export type Translator = (message: string, values?: TranslationValues) => string;

const frenchMessages: Record<string, string> = {
  ...pageMessages,
  ...historyMessages,
  ...signalMessages,
  ...rootMessages,
};

const translators: Record<Locale, Translator> = {
  en: (message, values) => interpolate(message, values),
  fr: (message, values) =>
    frenchSpacing(
      interpolate(
        Object.hasOwn(frenchMessages, message) ? (frenchMessages[message] ?? message) : message,
        values,
      ),
    ),
};

/** French typography keeps « », : ; ! ? and % on the same line as the word next to them. */
function frenchSpacing(text: string): string {
  return text
    .replace(/« /g, "«\u00a0")
    .replace(/ ([»:])/g, "\u00a0$1")
    .replace(/ ([;!?%])/g, "\u202f$1");
}

export function getTranslation(locale: Locale): Translator {
  return translators[locale];
}

function interpolate(message: string, values?: TranslationValues): string {
  if (!values) return message;
  return message.replace(/\{(\w+)\}/g, (placeholder, key: string) =>
    values[key] === undefined ? placeholder : String(values[key]),
  );
}
