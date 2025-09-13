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
app.get("/subs", async (req, res) => {
  const slug = (req.query.slug || "").trim();
  if (!slug) return res.status(400).json({ error: "Missing ?slug=" });

  const url = `https://kick.com/${slug}/about`;
  const log = [];
  let subs = 0;
  let foundRaw = "";

  const browser = await getBrowser();
  const page = await browser.newPage({
    userAgent:
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124 Safari/537.36",
    extraHTTPHeaders: { "Accept-Language": "de-DE,de;q=0.9,en;q=0.8" },
    viewport: { width: 1366, height: 900 },
  });

  try {
    await page.goto(url, { waitUntil: "domcontentloaded", timeout: 45000 });
    await page.waitForLoadState("networkidle", { timeout: 45000 });
    await page.waitForSelector("main", { timeout: 15000 });

    // Einmal komplett scrollen (manchmal lädt der Bereich erst dann)
    await page.evaluate(async () => {
      const delay = (ms) => new Promise((r) => setTimeout(r, ms));
      const h = document.body.scrollHeight;
      const step = Math.max(300, Math.floor(h / 6));
      for (let y = 0; y < h; y += step) {
        window.scrollTo(0, y);
        await delay(200);
      }
      window.scrollTo(0, 0);
    });

    // Consent wegklicken (best effort)
    try {
      const acceptBtn =
        (await page.$("text=Alle akzeptieren")) ||
        (await page.$("text=Akzeptieren")) ||
        (await page.$("text=Accept all")) ||
        (await page.$("text=Accept"));
      if (acceptBtn) {
        await acceptBtn.click({ timeout: 900 });
        log.push("consent_clicked");
      }
    } catch {}

    // --- 1) Bereich mit Label "Abonnements" (oder engl. Fallback) finden
    await page.waitForTimeout(500);
    await page.waitForSelector("main", { timeout: 10000 }).catch(() => {});

    const result = await page.evaluate(() => {
      const LABELS = ["Abonnements", "Abonnements!", "Abonnenten", "Subscribers", "Subscriptions"];

      const getNearestContainer = (el) => {
        // gehe bis zu 6 Ebenen hoch, um den umgebenden Block zu finden
        let p = el;
        for (let i = 0; i < 6 && p; i++) {
          if (p.querySelector('[role="progressbar"],div,section')) return p;
          p = p.parentElement;
        }
        return el;
      };

      // 1a) Suche nach Textknoten, die eines der Labels enthalten
      const walker = document.createTreeWalker(document.querySelector("main") || document.body, NodeFilter.SHOW_TEXT);
      let labelNode = null;
      while (walker.nextNode()) {
        const t = (walker.currentNode.nodeValue || "").trim();
        if (!t) continue;
        const hit = LABELS.some((l) => t.includes(l));
        if (hit) {
          labelNode = walker.currentNode;
          break;
        }
      }
      if (!labelNode) return { scope: "label_not_found" };

      const container = getNearestContainer(labelNode.parentElement || document.body);

      // 1b) Versuche zuerst ARIA Progressbar in der Nähe
      const pb = container.querySelector('[role="progressbar"][aria-valuenow]');
      if (pb) {
        const now = pb.getAttribute("aria-valuenow") || "";
        const max = pb.getAttribute("aria-valuemax") || "";
        return { scope: "aria_near_label", now, max, raw: now };
      }

      // 1c) Fallback: Lies sichtbaren Text des Containers und nimm die erste Zahl NACH dem Label
      // z.B. "Noch 39 Abonnements! 321 / 360"
      const text = (container.textContent || "").replace(/\s+/g, " ").trim();
      // Suche zuerst Muster "x / y"
      let m = text.match(/(\d[\d\.\s,]*)\s*\/\s*(\d[\d\.\s,]*)/);
      if (m) {
        return { scope: "text_ratio", raw: m[1] };
      }
      // danach irgendeine Zahl, die hinter dem Label vorkommt
      for (const L of LABELS) {
        const idx = text.indexOf(L);
        if (idx >= 0) {
          const tail = text.slice(idx + L.length);
          const m2 = tail.match(/(\d[\d\.\s,]*)/);
          if (m2) return { scope: "text_after_label", raw: m2[1] };
        }
      }
      // Letzter globaler Versuch: irgendein Ratio auf der Seite
      const any = document.body.textContent?.replace(/\s+/g, " ") || "";
      const g = any.match(/(\d[\d\.\s,]*)\s*\/\s*(\d[\d\.\s,]*)/);
      if (g) return { scope: "text_ratio_global", raw: g[1] };

      return { scope: "no_number_found" };
    });

    if (result?.raw || result?.now) {
      foundRaw = String(result.raw || result.now);
      subs = toInt(foundRaw);
      log.push(result.scope || "hit");
    } else {
      log.push(result?.scope || "miss");
    }

    await browser.close();
    return res.json({ subs, foundRaw, url, log });
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
