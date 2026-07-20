import { cookies } from "next/headers";
import { getDictionary as getSharedDictionary, isLocale, type Locale } from "@/lib/i18n";

export async function getLocaleFromCookies(): Promise<Locale> {
  const cookieStore = await cookies();
  const localeCookie = cookieStore.get("ash_locale")?.value;
  return isLocale(localeCookie) ? localeCookie : "en";
}

export const getDictionary = getSharedDictionary;
