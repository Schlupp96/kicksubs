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
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124 Safari/537.36",
    locale: "de-DE",
    timezoneId: "Europe/Berlin",
    viewport: { width: 1366, height: 900 },
  });
  const page = await ctx.newPage();

  // große Assets blocken (spart Zeit, vermeidet Hänger)
  await page.route("**/*", (route) => {
    const type = route.request().resourceType();
    if (["image", "media", "font"].includes(type)) return route.abort();
    route.continue();
  });

  try {
    await page.goto(url, { waitUntil: "domcontentloaded", timeout: 45000 });
    await page.waitForSelector("main", { timeout: 15000 });

    // Cookie-Banner best effort
    try {
      const btn =
        (await page.$("text=Alle akzeptieren")) ||
        (await page.$("text=Akzeptieren")) ||
        (await page.$("text=Accept all")) ||
        (await page.$("text=Accept"));
      if (btn) { await btn.click({ timeout: 1000 }); log.push("consent_clicked"); }
    } catch {}

    // leicht scrollen, um Lazy-Content zu laden
    await page.evaluate(async () => {
      const delay = (ms) => new Promise((r) => setTimeout(r, ms));
      for (let i = 0; i < 3; i++) { window.scrollBy(0, window.innerHeight); await delay(200); }
      window.scrollTo(0, 0);
    });

    // Warten bis die gesuchten Infos im DOM stehen (max 30s)
    const result = await page.waitForFunction(() => {
      const LABELS = ["Abonnements", "Abonnements!", "Abonnenten", "Subscribers", "Subscriptions"];
      const norm = (s) => (s || "").replace(/\s+/g, " ").trim();
      const main = document.querySelector("main") || document.body;

      // 1) Progressbar global
      const pbs = Array.from(main.querySelectorAll('[role="progressbar"][aria-valuenow]'));
      if (pbs.length) {
        // wähle den mit größtem aria-valuemax (typisch 360)
        let pick = pbs
          .map((el) => ({
            now: el.getAttribute("aria-valuenow") || "",
            max: el.getAttribute("aria-valuemax") || "",
            el,
          }))
          .sort((a, b) => (parseInt(b.max || "0", 10) || 0) - (parseInt(a.max || "0", 10) || 0))[0];
        if (pick?.now) return { scope: "aria_global", raw: pick.now, rawMax: pick.max, txt: "" };
      }

      // 2) Bereich um das Label
      const sections = [main, ...Array.from(main.querySelectorAll("section,div")).slice(0, 300)];
      let container = null;
      for (const el of sections) {
        const t = norm(el.textContent || "");
        if (LABELS.some((L) => t.includes(L))) { container = el; break; }
      }
      if (container) {
        const pb = container.querySelector('[role="progressbar"][aria-valuenow]');
        if (pb) {
          return {
            scope: "aria_near_label",
            raw: pb.getAttribute("aria-valuenow") || "",
            rawMax: pb.getAttribute("aria-valuemax") || "",
            txt: norm(container.textContent || ""),
          };
        }
        const t = norm(container.textContent || "");
        let m = t.match(/(\d[\d\.\s,]*)\s*\/\s*(\d[\d\.\s,]*)/);
        if (m) return { scope: "text_ratio", raw: m[1], txt: t };
        for (const L of LABELS) {
          const i = t.indexOf(L);
          if (i >= 0) {
            const tail = t.slice(i + L.length);
            const m2 = tail.match(/(\d[\d\.\s,]*)/);
            if (m2) return { scope: "text_after_label", raw: m2[1], txt: t };
          }
        }
      }

      // 3) globales „x / y“
      const all = norm(main.textContent || "");
      const g = all.match(/(\d[\d\.\s,]*)\s*\/\s*(\d[\d\.\s,]*)/);
      if (g) return { scope: "text_ratio_global", raw: g[1], txt: all };

      return null;
    }, { timeout: 30000, polling: 500 });

    if (result) {
      const r = await result.jsonValue();
      const raw = r.raw || "";
      foundRaw = raw;
      subs = toInt(raw);
      log.push(r.scope || "hit");
      if (debug) debugPeek = (r.txt || "").slice(0, 800);
    } else {
      log.push("no_result");
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
