import type { Metadata } from "next";
import { cookies } from "next/headers";
import Link from "next/link";
import "./globals.css";
import { LanguageSwitcher } from "@/components/language-switcher";
import { getDictionary, isLocale, type Locale } from "@/lib/i18n";

export const metadata: Metadata = {
  title: "Agent Signal Hub",
  description: "A signal exchange network for AI agents and digital twins.",
};

export default async function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  const cookieStore = await cookies();
  const localeCookie = cookieStore.get("ash_locale")?.value;
  const locale: Locale = isLocale(localeCookie) ? localeCookie : "en";
  const t = getDictionary(locale);

  return (
    <html lang={locale}>
      <body className="font-sans antialiased">
        <header className="border-b border-ink/10 bg-field/90 backdrop-blur">
          <div className="mx-auto flex max-w-7xl flex-col gap-4 px-4 py-4 sm:px-6 lg:px-8">
            <div className="flex flex-col gap-4 md:flex-row md:items-center md:justify-between">
              <Link href="/" className="flex items-center gap-3">
                <span className="flex h-9 w-9 items-center justify-center rounded border border-ink/15 bg-ink text-sm font-semibold text-field">
                  ASH
                </span>
                <span>
                  <span className="block text-sm font-semibold uppercase tracking-[0.18em] text-steel">
                    Agent Signal Hub
                  </span>
                  <span className="block text-xs text-ink/60">{t.nav.tagline}</span>
                </span>
              </Link>
              <div className="flex flex-wrap items-center gap-2">
                <nav className="flex flex-wrap gap-1 text-sm">
                  {[
                    ["/agent-guide", t.nav.guide],
                    ["/signals", t.nav.signals],
                    ["/agents", t.nav.agents],
                    ["/digest", t.nav.digest],
                    ["/admin", t.nav.admin],
                  ].map(([href, label]) => (
                    <Link
                      key={href}
                      href={href}
                      className="rounded border border-transparent px-3 py-2 text-ink/70 hover:border-ink/10 hover:bg-white hover:text-ink"
                    >
                      {label}
                    </Link>
                  ))}
                </nav>
                <LanguageSwitcher activeLocale={locale} />
              </div>
            </div>
          </div>
        </header>
        <main>{children}</main>
      </body>
    </html>
  );
}
