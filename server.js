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

/* 3) Abonnements-basiert: Zahl VOR dem Slash nahe dem Label holen */
if (!subs) {
  const around = await page.evaluate(() => {
    // Wir suchen *gezielt* nach dem Label und lesen im selben Block das Muster "X / Y"
    const LABELS = ["Abonnement", "Abonnements", "Abonnements!", "Abonnenten", "Subscribers", "Subscriptions"];
    const norm = (s) => (s || "").replace(/\s+/g, " ").trim().toLowerCase();
    const main = document.querySelector("main") || document.body;

    const findLabelElements = () => {
      const nodes = [main, ...Array.from(main.querySelectorAll("*")).slice(0, 4000)];
      return nodes.filter((el) => {
        const t = norm(el.textContent || "");
        if (!t) return false;
        return LABELS.some((L) => t.includes(L.toLowerCase()));
      });
    };

    const findRatioIn = (root) => {
      if (!root) return null;

      // 1) Im Text der Nachfahren
      const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
      while (walker.nextNode()) {
        const txt = (walker.currentNode.nodeValue || "").replace(/\s+/g, " ").trim();
        const m = txt.match(/(\d[\d\.\s,]*)\s*\/\s*(\d[\d\.\s,]*)/);
        if (m) return { num: m[1], den: m[2], src: "desc_text" };
      }

      // 2) In Attributen (aria-label, title, data-*)
      const nodes = root.querySelectorAll("*");
      for (const n of [root, ...nodes]) {
        for (const a of Array.from(n.attributes || [])) {
          const m = (a.value || "").match(/(\d[\d\.\s,]*)\s*\/\s*(\d[\d\.\s,]*)/);
          if (m) return { num: m[1], den: m[2], src: "attr" };
        }
      }

      return null;
    };

    const labels = findLabelElements();
    for (const el of labels) {
      // a) im Container (wenn nötig bis zu 6 Ebenen hoch)
      let p = el;
      for (let i = 0; i < 6 && p; i++) {
        const hit = findRatioIn(p);
        if (hit) return { raw: hit.num, den: hit.den, scope: "near_label" };
        p = p.parentElement;
      }
      // b) in den nächsten Geschwistern
      let s = el.nextElementSibling;
      for (let i = 0; i < 6 && s; i++) {
        const hit = findRatioIn(s);
        if (hit) return { raw: hit.num, den: hit.den, scope: "label_sibling" };
        s = s.nextElementSibling;
      }
    }

    // c) Fallback: global erstes "X / Y" – nimm die Zahl *vor* dem Slash
    const text = (main.textContent || "").replace(/\s+/g, " ").trim();
    const mg = text.match(/(\d[\d\.\s,]*)\s*\/\s*(\d[\d\.\s,]*)/);
    if (mg) return { raw: mg[1], den: mg[2], scope: "global_ratio" };

    return null;
  });

  if (around?.raw) {
    foundRaw = around.raw;          // <- das ist die "321"
    subs = toInt(foundRaw);
    log.push(around.scope);
  } else {
    log.push("abonnements_scan_miss");
  }
}


    // Challenge-Erkennung (nur für Diagnose)
    if (!subs) {
      const txt = await page.evaluate(() => (document.body.innerText || "").toLowerCase());
      if (/(access denied|verify you are human|enable javascript|cloudflare)/i.test(txt)) {
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

/* ---------------- /subs-text ---------------- */
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

/* ---------------- Start ---------------- */
app.listen(PORT, () => {
  console.log(`Server listening on port ${PORT}`);
});
