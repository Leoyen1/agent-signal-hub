"use client";

import { Languages } from "lucide-react";
import { setLocaleAction } from "@/app/actions";
import { locales, getDictionary, type Locale } from "@/lib/i18n";

export function LanguageSwitcher({ activeLocale }: { activeLocale: Locale }) {
  const t = getDictionary(activeLocale);

  return (
    <form action={setLocaleAction} className="flex items-center gap-2 rounded border border-ink/10 bg-white px-2 py-1">
      <Languages size={15} className="text-steel" />
      <select
        name="locale"
        defaultValue={activeLocale}
        onChange={(event) => event.currentTarget.form?.requestSubmit()}
        className="bg-transparent text-sm outline-none"
        aria-label="Language"
      >
        {locales.map((locale) => (
          <option key={locale} value={locale}>
            {t.localeNames[locale]}
          </option>
        ))}
      </select>
    </form>
  );
}
