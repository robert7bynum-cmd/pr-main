/**
 * The member page in two languages, and the page it shows with no signal.
 *
 * Both are things a person on the course finds broken long before any log
 * does: a Spanish label that is blank because someone added an English key
 * and forgot the other, a phone that should have picked Spanish and did not,
 * a dead zone that is a browser error page again because a service-worker
 * edit dropped the fetch handler. All pure — no database, no browser.
 */
import { readFileSync } from "node:fs";
import { LANGS, MEMBER_STRINGS, fill, pickLang } from "../lib/i18n/member";

let pass = 0, fail = 0;
const check = (n: string, ok: boolean, d = "") => { ok ? pass++ : fail++; console.log(`  ${ok ? "ok  " : "FAIL"} ${n}${ok ? "" : "  -> " + d}`); };

console.log("every string exists in every language");
const keys = Object.keys(MEMBER_STRINGS.en).sort();
for (const lang of LANGS) {
  const have = Object.keys(MEMBER_STRINGS[lang]).sort();
  check(`${lang} has exactly the English keys`, JSON.stringify(have) === JSON.stringify(keys),
    `missing: ${keys.filter((k) => !have.includes(k))} extra: ${have.filter((k) => !keys.includes(k))}`);
  for (const k of keys) {
    const v = (MEMBER_STRINGS[lang] as Record<string, string>)[k];
    check(`${lang}.${k} is a non-empty string`, typeof v === "string" && v.trim().length > 0);
  }
}
check("the two languages are not the same text",
  keys.filter((k) => (MEMBER_STRINGS.en as Record<string, string>)[k] !== (MEMBER_STRINGS.es as Record<string, string>)[k]).length >= keys.length - 2);
check("the placeholder survives in both confirmation bodies",
  LANGS.every((l) => MEMBER_STRINGS[l].doneBody.includes("{location}")));
check("fill replaces it", fill(MEMBER_STRINGS.es.doneBody, { location: "hoyo 7" }).includes("hoyo 7"));
check("fill leaves an unknown placeholder alone", fill("{nope} x", {}) === "{nope} x");

console.log("\nwhich language to show");
check("?lang=es wins over an English phone", pickLang("es", "en-US,en;q=0.9") === "es");
check("?lang=en wins over a Spanish phone", pickLang("en", "es-MX,es;q=0.9") === "en");
check("a repeated param uses the first", pickLang(["es", "en"], null) === "es");
check("no param, es-MX phone → es", pickLang(undefined, "es-MX,es;q=0.9,en;q=0.8") === "es");
check("no param, bare es → es", pickLang(undefined, "es") === "es");
check("no param, en-US phone → en", pickLang(undefined, "en-US,en;q=0.9") === "en");
check("no param, no header → en", pickLang(undefined, null) === "en");
check("garbage param, garbage header → en", pickLang("fr", "zz-ZZ;;;") === "en");
check("garbage param falls through to the phone", pickLang("de", "es-ES") === "es");
check("an English phone that also accepts Spanish stays English",
  pickLang(undefined, "en-US,es;q=0.8") === "en");
check("Estonian is not Spanish", pickLang(undefined, "et-EE") === "en");

console.log("\nthe service worker still knows how to be offline");
const sw = readFileSync("public/sw.js", "utf8");
const version = /const SW_VERSION = (\d+);/.exec(sw)?.[1];
check("SW_VERSION is a number", Boolean(version), sw.slice(0, 200));
check("the offline cache name is versioned by it",
  /OFFLINE_CACHE = `proresponse-offline-v\$\{SW_VERSION\}`/.test(sw));
check("install caches the offline page", sw.includes('self.addEventListener("install"') && sw.includes("cache.add(new Request(OFFLINE_URL"));
check("activate deletes other caches", sw.includes('self.addEventListener("activate"') && sw.includes("caches.delete(n)"));
check("fetch handles navigations only",
  sw.includes('self.addEventListener("fetch"') && sw.includes('event.request.mode !== "navigate") return;'));
check("the offline page is what a failed navigation gets",
  sw.includes("caches.match(OFFLINE_URL, { cacheName: OFFLINE_CACHE })"));
check("nothing else is cached — no cache.put, no addAll",
  !sw.includes("cache.put(") && !sw.includes("addAll("));
check("the push handler is still there", sw.includes('self.addEventListener("push"'));
check("and still buzzes", sw.includes("vibrate: BUZZ[urgency] || BUZZ.normal"));
check("the notificationclick handler is still there", sw.includes('self.addEventListener("notificationclick"'));

console.log("\nthe offline page says the right thing in both languages");
const offline = readFileSync("public/offline.html", "utf8");
check("it exists and is a page", offline.startsWith("<!doctype html>"));
check("English: the report is not lost", offline.includes("Your report was not lost if you did not press send"));
check("Spanish: the report is not lost", offline.includes("Su reporte no se perdió si no presionó enviar"));
check("it says to try again when there is a bar", offline.includes("Try again when you have a bar"));
check("it loads nothing from the network", !/<(script|link|img)\b/.test(offline) && !offline.includes("@import"));

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
