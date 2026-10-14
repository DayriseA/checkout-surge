import type { Metadata } from "next";
import Link from "next/link";
import { textLinkClassName } from "./components/control-styles";
import { getLocale } from "./lib/i18n/server";
import { getTranslation } from "./lib/i18n/translate";

export async function generateMetadata(): Promise<Metadata> {
  const t = getTranslation(await getLocale());
  return { title: t("Page not found") };
}

export default async function NotFound() {
  const locale = await getLocale();
  const t = getTranslation(locale);

  return (
    <>
      <header className="mb-4">
        <h1 className="type-display m-0 text-[clamp(2rem,4vw,2.75rem)] leading-none text-ink">
          {t("Page not found")}
        </h1>
        <p className="mt-3 max-w-[66ch] leading-6 text-muted">
          {t("We could not find this page or saved run report.")}
        </p>
      </header>
      <div className="flex flex-wrap gap-3">
        <Link className={textLinkClassName} href="/run-history">
          {t("Back to run history")}
        </Link>
        <Link className={textLinkClassName} href="/">
          {t("Go to the demo home")}
        </Link>
      </div>
    </>
  );
}
