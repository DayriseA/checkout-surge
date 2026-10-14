import type { BackendRead } from "../backend-read";
import { getTranslation, type Locale } from "../i18n/translate";
import { formatCount, pluralize } from "./format";

export type AdminMessageValues = Record<string, string | number | { count: number; noun?: string }>;

export interface AdminMessage {
  messageKey: string;
  values?: AdminMessageValues;
}

export type AdminNotice =
  | string
  | (AdminMessage & { kind: "message" })
  | {
      kind: "failure";
      read: BackendRead<unknown>;
    };

export function adminFailureNotice(read: BackendRead<unknown>): AdminNotice {
  return { kind: "failure", read };
}

/** Keep source messages and their data in state; translate when they are displayed. */
export function adminMessageText(message: AdminMessage, locale: Locale): string {
  const t = getTranslation(locale);
  const values = Object.fromEntries(
    Object.entries(message.values ?? {}).map(([key, value]) => {
      if (typeof value === "string") return [key, t(value)];
      if (typeof value === "number") return [key, value];
      const count = formatCount(value.count, locale) ?? t("not recorded");
      return [key, value.noun ? `${count} ${t(pluralize(value.count, value.noun))}` : count];
    }),
  );
  return t(message.messageKey, values);
}
