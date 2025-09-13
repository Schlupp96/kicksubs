import express from "express";
import { chromium } from "playwright";

const app = express();
const PORT = process.env.PORT || 3000;

/* ---------------- Helper ---------------- */
const toInt = (text) => {
  if (!text) return 0;
  const s = String(text).toLowerCase().replace(/,/g, ".").replace(/\s/g, "").trim();
  if (s.endsWith("k")) {
    const base = parseFloat(s.slice(0, -1));
    return Number.isFinite(base) ? Math.round(base * 1000) : 0;
  }
  const n = parseInt(s.replace(/[^\d]/g, ""), 10);
  return Number.isFinite(n) ? n : 0;
};

async function createBrowser() {
  return chromium.launch({
    headless: true,
    args: [
      "--no-sandbox",
      "--disable-setuid-sandbox",
      "--disable-dev-shm-usage",
      "--disable-gpu",
      "--disable-blink-features=AutomationControlled",
    ],
  });
}

/* ---------------- /subs ---------------- */
app.get("/subs", async (req, res) => {
  const slug = (req.query.slug || "").trim();
  const debug = String(req.query.debug || "") === "1";
  if (!slug) return res.status(400).json({ error: "Missing ?slug=" });

  const url = `https://kick.com/${slug}/about`;
  const log = [];
  let subs = 0;
  let foundRaw = "";
  let debugPeek = "";

  const browser = await createBrowser();
  const ctx = await browser.newContext({
    userAgent:
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
    locale: "de-DE",
    timezoneId: "Europe/Berlin",
    viewport: { width: 1368, height: 900 },
    extraHTTPHeaders: {
      "Accept-Language": "de-DE,de;q=0.9,en-US;q=0.8,en;q=0.7",
      "Upgrade-Insecure-Requests": "1",
    },
  });

  // minimales Stealth
  await ctx.addInitScript(() => {
    Object.defineProperty(navigator, "webdriver", { get: () => false });
    Object.defineProperty(navigator, "languages", { get: () => ["de-DE", "de", "en-US", "en"] });
    Object.defineProperty(navigator, "plugins", { get: () => [1, 2, 3] });
  });

  const page = await ctx.newPage();

  // eher schlank: Bilder & Media blocken, Fonts/CSS/JS erlauben
  await page.route("**/*", (route) => {
    const t = route.request().resourceType();
    if (["image", "media"].includes(t)) return route.abort();
    return route.continue();
  });

  try {
    // kein networkidle / kein waitForSelector('body') mehr
    await page.goto(url, { waitUntil: "domcontentloaded", timeout: 45000 });

    // Cookiebanner (best effort)
    try {
      const btn =
        (await page.$("text=Alle akzeptieren")) ||
        (await page.$("text=Akzeptieren")) ||
        (await page.$("text=Accept all")) ||
        (await page.$("text=Accept"));
      if (btn) { await btn.click({ timeout: 800 }); log.push("consent_clicked"); }
    } catch {}

    // sanft anscrollen + kleiner Delay, damit SPA hydratisiert
    await page.evaluate(async () => {
      const sleep = (ms) => new Promise(r => setTimeout(r, ms));
      for (let i = 0; i < 2; i++) { window.scrollBy(0, window.innerHeight); await sleep(200); }
      window.scrollTo(0, 0);
    });
    await page.waitForTimeout(1200);

    /* 1) ARIA Progressbar */
    try {
      const aria = await page.$$eval('[role="progressbar"][aria-valuenow]', els =>
        els.map(e => ({
          now: e.getAttribute("aria-valuenow") || "",
          max: e.getAttribute("aria-valuemax") || "",
        }))
      );
      if (aria && aria.length) {
        aria.sort((a,b) => (parseInt(b.max||"0",10)||0) - (parseInt(a.max||"0",10)||0));
        const pick = aria[0];
        const n = parseInt(String(pick.now).replace(/[^\d]/g, ""), 10) || 0;
        if (n) {
          subs = n;
          foundRaw = pick.now + (pick.max ? ` / ${pick.max}` : "");
          log.push("aria_found");
        } else {
          log.push("aria_zero");
        }
      } else {
        log.push("aria_none");
      }
    } catch { log.push("aria_error"); }

    /* 2) Sichtbarer Text */
    if (!subs) {
      const bodyText = await page.evaluate(() => (document.body.innerText || "").replace(/\s+/g, " ").trim());
      if (debug) debugPeek = bodyText.slice(0, 400);

      // Zahl direkt hinter Label
      const lower = bodyText.toLowerCase();
      const labels = ["abonnements!", "abonnements", "abonnenten", "subscribers", "subscriptions"];
      let afterIdx = -1;
      for (const L of labels) { const i = lower.indexOf(L); if (i >= 0) { afterIdx = i + L.length; break; } }
      if (afterIdx >= 0) {
        const tail = bodyText.slice(afterIdx);
        const mAfter = tail.match(/(\d[\d\.,\s]*)/);
        if (mAfter) { foundRaw = mAfter[1]; subs = toInt(foundRaw); log.push("text_after_label"); }
      }

      // „x / y“ im sichtbaren Text
      if (!subs) {
        const mRatio = bodyText.match(/(\d[\d\.\s,]*)\s*\/\s*(\d[\d\.\s,]*)/);
        if (mRatio) { foundRaw = mRatio[1]; subs = toInt(foundRaw); log.push("text_ratio_visible"); }
      }
    }

    /* 3) HTML + Umfeld „Abonnements“ (inkl. Attribute) */
    if (!subs) {
      const html = await page.content();

      // globales „x / y“ im HTML
      const mHtml = html.match(/(\d[\d\.\s,]*)\s*\/\s*(\d[\d\.\s,]*)/);
      if (mHtml) {
        foundRaw = mHtml[1];
        subs = toInt(foundRaw);
        log.push("text_ratio_html");
      } else {
        const around = await page.evaluate(() => {
          const LABELS = ["Abonnements","Abonnements!","Abonnenten","Subscribers","Subscriptions"];
          const norm = (s) => (s || "").replace(/\s+/g, " ").trim();
          const main = document.querySelector("main") || document.body;
          const candidates = Array.from(main.querySelectorAll("*")).filter(el => {
            const txt = norm(el.textContent || "");
            const attrs = Array.from(el.attributes || []).map(a => `${a.name}=${a.value}`).join(" ");
            return LABELS.some(L => txt.includes(L) || attrs.toLowerCase().includes(L.toLowerCase()));
          });
          const firstNum = (s) => {
            const m = norm(s).match(/(\d[\d\.\s,]*)/);
            return m ? m[1] : "";
          };
          for (const el of candidates) {
            const t = norm(el.textContent || "");
            let m = t.match(/(\d[\d\.\s,]*)\s*\/\s*(\d[\d\.\s,]*)/);
            if (m) return { scope: "near_label_ratio", raw: m[1] };
            const ih = norm(el.innerHTML || "");
