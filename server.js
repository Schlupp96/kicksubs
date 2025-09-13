import express from "express";
import { chromium } from "playwright";

const app = express();
const PORT = process.env.PORT || 3000;

/* ---------------- Helpers ---------------- */
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

/* ---------------- Page helpers ---------------- */

// Öffnet sicher den „Über/About“-Tab, falls die SPA nicht korrekt dort gelandet ist
async function ensureAboutOpen(page) {
  try {
    const link =
      (await page.$('a[href$="/about"]')) ||
      (await page.$('a:has-text("Über")')) ||
      (await page.$('a:has-text("About")'));
    if (link) {
      await link.click({ delay: 40 });
      await page.waitForTimeout(1200);
    }
  } catch {}
}

// Scrollt die Seite einmal vollständig durch (Lazy-Loading anstoßen)
async function deepScroll(page) {
  await page.evaluate(async () => {
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    let y = 0;
    let h = document.body.scrollHeight;
    while (y + innerHeight < h && y < 30000) {
      y += Math.floor(innerHeight * 0.9);
      scrollTo(0, y);
      await sleep(250);
      h = document.body.scrollHeight;
    }
    scrollTo(0, 0);
  });
}

// Liest im Umfeld des Labels „Abonnements/…“ die Zahl **vor** dem Slash („X / Y“) aus
async function readSubsNearLabel(page) {
  return page.evaluate(() => {
    const LABELS = ["Abonnement", "Abonnements", "Abonnenten", "Subscribers", "Subscriptions"];
    const norm = (s) => (s || "").replace(/\s+/g, " ").trim();
    const main = document.querySelector("main") || document.body;

    const ratioFrom = (root) => {
      if (!root) return null;
      const nodes = [root, ...root.querySelectorAll("*")];
      for (const n of nodes) {
        const t = norm(n.textContent || "");
        let m = t.match(/(\d[\d\.\s,]*)\s*\/\s*(\d[\d\.\s,]*)/);
        if (m) return { num: m[1], scope: "near_label_text" };
        for (const a of Array.from(n.attributes || [])) {
          const v = norm(a.value || "");
          m = v.match(/(\d[\d\.\s,]*)\s*\/\s*(\d[\d\.\s,]*)/);
          if (m) return { num: m[1], scope: "near_label_attr" };
        }
      }
      return null;
    };

    // Erstes Element, das eines der Label-Wörter enthält
    const all = [main, ...Array.from(main.querySelectorAll("*")).slice(0, 5000)];
    const labelEl = all.find((el) =>
      LABELS.some((L) => (el.textContent || "").toLowerCase().includes(L.toLowerCase()))
    );
    if (!labelEl) return null;

    // a) Im Container / Eltern (bis 6 Ebenen)
    let p = labelEl;
    for (let i = 0; i < 6 && p; i++) {
      const r = ratioFrom(p);
      if (r) return { raw: r.num, scope: r.scope };
      p = p.parentElement;
    }
    // b) In nachfolgenden Geschwistern (bis 8 Schritte)
    let s = labelEl.nextElementSibling;
    for (let i = 0; i < 8 && s; i++) {
      const r = ratioFrom(s);
      if (r) return { raw: r.num, scope: "near_label_sibling" };
      s = s.nextElementSibling;
    }

    // c) HTML-Fallback: „abonn… … X / Y“ (bis 1200 Zeichen danach)
    const html = document.documentElement?.innerHTML || "";
    const m = html.match(/abonn\w*[\s\S]{0,1200}?(\d[\d\.\s,]*)\s*\/\s*(\d[\d\.\s,]*)/i);
    if (m) return { raw: m[1], scope: "html_after_label" };

    return null;
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

  try {
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

    // ==== bis zu 4 Versuche: Tab öffnen, scrollen, dann lesen ====
    for (let attempt = 1; attempt <= 4 && !subs; attempt++) {
      await ensureAboutOpen(page);
      await deepScroll(page);
      await page.waitForTimeout(700);

      // 1) ARIA-Progressbar (wenn vorhanden)
      try {
        const ariaVals = await page.$$eval('[role="progressbar"][aria-valuenow]', els =>
          els.map(e => e.getAttribute("aria-valuenow") || "").filter(Boolean)
        );
        if (ariaVals.length) {
          const raw = ariaVals[0];
          const n = toInt(raw);
          if (n) {
            subs = n;
            foundRaw = raw;
            log.push("aria_found");
            break;
          }
        } else {
          log.push("aria_none");
        }
      } catch { log.push("aria_error"); }

      // 2) Strikt am Label „Abonn…“ → „X / Y“ → X
      const near = await readSubsNearLabel(page);
      if (near?.raw) {
        foundRaw = near.raw;
        subs = toInt(foundRaw);
        log.push(near.scope);
        break;
      } else {
        log.push("abonnements_scan_miss");
      }

      await page.waitForTimeout(900);
    }

    if (debug && !foundRaw) {
      const text = await page.evaluate(() => (document.body.innerText || "").replace(/\s+/g, " ").trim());
      debugPeek = text.slice(0, 400);
    }

    await browser.close();
    return res.json({ subs, foundRaw, url, log, ...(debug ? { debugPeek } : {}) });
  } catch (e) {
    await browser.close();
    return res.status(500).json({ error: e.message, url, log });
  }
});

/* ---------------- /subs-text ---------------- */
app.get("/subs-text", async (req, res) => {
  const slug = (req.query.slug || "").trim();
  const name = (req.query.name || slug || "Der Kanal").trim();
  if (!slug) return res.status(400).type("text/plain").send("Missing ?slug=");

  let subs = 0;
  try {
    // Immer lokal aufrufen – stabil auf Render
    const local = `http://127.0.0.1:${PORT}/subs?slug=${encodeURIComponent(slug)}`;
    const r = await fetch(local);
    if (r.ok) {
      const j = await r.json();
      if (typeof j.subs === "number" && Number.isFinite(j.subs)) subs = j.subs;
    }
  } catch {}

  res
    .type("text/plain; charset=utf-8")
    .send(`🎁 ${name} hat aktuell ${subs} Subscriber 💚`);
});

/* ---------------- Start ---------------- */
app.listen(PORT, () => {
  console.log(`Server listening on port ${PORT}`);
});
