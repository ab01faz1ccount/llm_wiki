import i18n from "i18next"
import { initReactI18next } from "react-i18next"
import en from "./en.json"
import it from "./it.json"
import zh from "./zh.json"
import ru from "./ru.json"
import fa from "./fa.json"

/** UI languages that read right-to-left. Only affects the app shell
 * (menus, panels, chat bubbles, settings) via `<html dir>` — per-document
 * content direction (an individual wiki page or PDF/EPUB) is detected and
 * set independently per file, see `src/lib/language-metadata.ts`. */
const RTL_LANGUAGES = new Set(["fa"])

function applyDocumentDirection(language: string) {
  if (typeof document === "undefined") return
  const dir = RTL_LANGUAGES.has(language) ? "rtl" : "ltr"
  document.documentElement.dir = dir
  document.documentElement.lang = language
}

i18n.use(initReactI18next).init({
  resources: {
    en: { translation: en },
    it: { translation: it },
    zh: { translation: zh },
    ru: { translation: ru },
    fa: { translation: fa },
  },
  lng: "en",
  fallbackLng: "en",
  interpolation: { escapeValue: false },
})

i18n.on("languageChanged", applyDocumentDirection)
applyDocumentDirection(i18n.language)

export default i18n
