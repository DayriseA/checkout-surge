"use client";

import { createContext, type ReactNode, useContext } from "react";
import type { Locale } from "./locale";
import { getTranslation } from "./translate";

const LocaleContext = createContext<Locale>("en");

export function LocaleProvider({ children, locale }: { children: ReactNode; locale: Locale }) {
  return <LocaleContext.Provider value={locale}>{children}</LocaleContext.Provider>;
}

export function useLocale(): Locale {
  return useContext(LocaleContext);
}

export function useTranslation() {
  return getTranslation(useLocale());
}
