import express from "express";
import { chromium } from "playwright";

const app = express();
const PORT = process.env.PORT || 3000;

/* ---------- Helfer ---------- */
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

async function getBrowser() {
  return chromium.launch({
    headless: true,
    args: ["--no-sandbox", "--disable-setuid-sandbox"],
  });
}

/* =======================================================================
   /subs – Abonnenten (Subscriber) auslesen
   ======================================================================= */
async function getBrowser() {
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

app.get("/subs", async (req, res) => {
  const slug = (req.query.slug || "").trim();
  const debug = String(req.query.debug || "") === "1";
  if (!slug) return res.status(400).json({ error: "Missing ?slug=" });

  const url = `https://kick.com/${slug}/about`;
  const log = [];
  let subs = 0;
  let foundRaw = "";
  let debugPeek = "";

  const browser = await getBrowser();
  const ctx = await browser.newContext({
    userAgent:
      // „normale“ Chrome-UA
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
    locale: "de-DE",
    timezoneId: "Europe/Berlin",
    viewport: { width: 1368, height: 900 },
    extraHTTPHeaders: {
      "Accept-Language": "de-DE,de;q=0.9,en-US;q=0.8,en;q=0.7",
      "Upgrade-Insecure-Requests": "1",
    },
  });

  // Minimales Stealth
  await ctx.addInitScript(() => {
    Object.defineProperty(navigator, "webdriver", { get: () => false });
    // Fake plugins & languages
    Object.defineProperty(navigator, "languages", { get: () => ["de-DE", "de", "en-US", "en"] });
    Object.defineProperty(navigator, "plugins", { get: () => [1, 2, 3] });
  });

  const page = await ctx.newPage();

  // Große Assets blocken (schneller, aber JS/CSS erlauben)
  await page.route("**/*", (route) => {
    const t = route.request().resourceType();
    if (["image", "media", "font"].includes(t)) return route.abort();
    return route.continue();
  });

  try {
    await page.goto(url, { waitUntil: "domcontentloaded", timeout: 45000 });
    await page.waitForSelector("body", { timeout: 15000 });

    // Cookie-Button best effort
    try {
      const btn =
        (await page.$("text=Alle akzeptieren")) ||
        (await page.$("text=Akzeptieren")) ||
        (await page.$("text=Accept all")) ||
        (await page.$("text=Accept"));
      if (btn) { await btn.click({ timeout: 800 }); log.push("consent_clicked"); }
    } catch {}

    // Ganz leicht scrollen, dann kurzen Delay – wir warten NICHT endlos
    await page.evaluate(async () => {
      const sleep = (ms) => new Promise(r => setTimeout(r, ms));
      for (let i = 0; i < 2; i++) { window.scrollBy(0, window.innerHeight); await sleep(200); }
      window.scrollTo(0, 0);
    });
    await page.waitForTimeout(1000);

    // 1) Direkt Progressbars prüfen (wenn vorhanden)
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
        }
      } else {
        log.push("aria_none");
      }
    } catch { log.push("aria_error"); }

    // 2) Wenn noch nichts: Nur mit **sichtbarem Text** arbeiten (robust gegen SPA/CF)
    if (!subs) {
      const bodyText = await page.evaluate(() => (document.body.innerText || "").replace(/\s+/g, " ").trim());
      if (debug) debugPeek = bodyText.slice(0, 800);

      // a) Bereich um Label "Abonnements/Subscribers" → erste Zahl DAHINTER
      const labelIdx = (() => {
        const labels = ["Abonnements!", "Abonnements", "Abonnenten", "Subscribers", "Subscriptions"];
        const lower = bodyText.toLowerCase();
        for (const L of labels) {
          const i = lower.indexOf(L.toLowerCase());
          if (i >= 0) return i + L.length;
        }
        return -1;
      })();

      if (labelIdx >= 0) {
        const tail = bodyText.slice(labelIdx);
        const mAfter = tail.match(/(\d[\d\.,\s]*)/);
        if (mAfter) {
          foundRaw = mAfter[1];
          subs = toInt(foundRaw);
          log.push("text_after_label");
        }
      }

      // b) Fallback: erstes „x / y“ auf der Seite
      if (!subs) {
        const mRatio = bodyText.match(/(\d[\d\.\s,]*)\s*\/\s*(\d[\d\.\s,]*)/);
        if (mRatio) {
          foundRaw = mRatio[1];
          subs = toInt(foundRaw);
          log.push("text_ratio_global");
        } else {
          log.push("text_no_match");
        }
      }

      // c) Erkenne typische Block-/Challenge-Seiten
      if (!subs && /access denied|verify you are human|enable javascript|cloudflare/i.test(bodyText)) {
        log.push("challenge_detected");
      }
    }

    await browser.close();
    const out = { subs, foundRaw, url, log };
    if (debug) out.debugPeek = debugPeek;
    return res.json(out);
  } catch (e) {
    await browser.close();
    return res.status(500).json({ error: e.message, url, log });
  }
});

/* =======================================================================
   /subs-text – nur Textantwort (für Botrix/Chat)
   ======================================================================= */
app.get("/subs-text", async (req, res) => {
  const slug = (req.query.slug || "").trim();
  const name = (req.query.name || slug || "Der Kanal").trim();
  if (!slug) return res.status(400).type("text/plain").send("Missing ?slug=");

  let subs = 0;
  try {
    const u = new URL(`${req.protocol}://${req.get("host")}/subs`);
    u.searchParams.set("slug", slug);
    const r = await fetch(u.toString());
    if (r.ok) {
      const j = await r.json();
      if (typeof j.subs === "number") subs = j.subs;
    }
  } catch {}

  res.type("text/plain; charset=utf-8").send(`🎁 ${name} hat aktuell ${subs} Subscriber 💚`);
});

/* ---------- Server starten ---------- */
app.listen(PORT, () => {
  console.log(`Server listening on port ${PORT}`);
});
