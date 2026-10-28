// SORS — import des concerts bdxc.fr dans la base Supabase existante
// (events + event_occurrences + venues + event_source_aliases)
//
// Usage :
//   node scrape-bdxc.mjs          → scrape + import via la fonction SQL import_external_events
//   node scrape-bdxc.mjs --dry    → scrape + affiche ce qui serait envoyé, n'écrit rien
//   node scrape-bdxc.mjs --dump   → sauvegarde le HTML brut dans debug/ (pour ajuster les sélecteurs)
//
// Variables : SUPABASE_URL, SUPABASE_SERVICE_KEY (obligatoires sauf en --dry)
//             DAYS=21  CATEGORIES=concerts  EVENT_TYPE=concert

import * as cheerio from "cheerio";
import { writeFile, mkdir } from "node:fs/promises";

const BASE = "https://www.bdxc.fr";
const SOURCE = "bdxc";
const DAYS = Number(process.env.DAYS ?? 21);
const CATEGORIES = (process.env.CATEGORIES ?? "concerts").toLowerCase().split(",").map(s => s.trim());
const EVENT_TYPE = process.env.EVENT_TYPE ?? "concert";
const SB_URL = process.env.SUPABASE_URL;
const SB_KEY = process.env.SUPABASE_SERVICE_KEY;
const DELAY_MS = Number(process.env.DELAY_MS ?? 800); // ~1 requête/seconde sur bdxc.fr
const UA = "SORS-bot/1.0 (+https://www.sors-bordeaux.com)";
const DRY = process.argv.includes("--dry");
const DUMP = process.argv.includes("--dump");

const sleep = ms => new Promise(r => setTimeout(r, ms));
const clean = s => (s ?? "").replace(/\s+/g, " ").trim();
// texte avec un espace entre chaque nœud (évite "20h30Rock School"), sans scripts/styles
const textOf = ($, el) => clean($(el).find("*").addBack().contents()
  .filter((_, n) => n.type === "text" && !["script", "style"].includes(n.parent?.name))
  .map((_, n) => n.data).get().join(" "));
// "Le Krakatoa" / "krakatoa" / "KRAKATOA (Mérignac)" → "krakatoa"
const norm = s => (s ?? "").normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase()
  .replace(/\(.*?\)/g, " ").replace(/\b(le|la|les|l|du|de|des|au|aux)\b/g, " ")
  .replace(/[^a-z0-9]+/g, " ").trim();

async function get(url, { json = false, delay = DELAY_MS } = {}) {
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const res = await fetch(url, { headers: { "User-Agent": UA, "Accept-Language": "fr-FR" } });
      if (res.status === 404) return null;
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return json ? await res.json() : await res.text();
    } catch (e) {
      if (attempt === 3) { console.warn(`✗ ${url} : ${e.message}`); return null; }
      await sleep(2000 * attempt);
    } finally {
      await sleep(delay);
    }
  }
}

async function sb(path, { method = "GET", body } = {}) {
  const res = await fetch(`${SB_URL}/rest/v1/${path}`, {
    method,
    headers: { apikey: SB_KEY, Authorization: `Bearer ${SB_KEY}`, "Content-Type": "application/json" },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) throw new Error(`Supabase ${method} ${path} → ${res.status} : ${await res.text()}`);
  return res.json();
}

const isoDay = offset => new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/Paris" })
  .format(new Date(Date.now() + offset * 86400000)); // YYYY-MM-DD à Paris

// ---------- 1. Page agenda d'un jour ----------
// Titres + liens dans l'ordre du document : le dernier titre de section rencontré = la catégorie.
export function parseAgenda(html, day) {
  const $ = cheerio.load(html);
  const out = [];
  let section = null;
  $("h1, h2, h3, h4, a[href*='/evenements/']").each((_, el) => {
    if (el.tagName !== "a") {
      if ($(el).closest("a").length) return; // titre d'une carte, pas une section
      const m = clean($(el).text()).toLowerCase().match(/^(concerts?|spectacles?|expositions?)\b/);
      if (m) section = m[1].replace(/s?$/, "s");
      return;
    }
    const href = $(el).attr("href");
    if (!/\/evenements\/[^/]+\/\d{4}-\d{2}-\d{2}\/[^/]+/.test(href)) return;
    const url = new URL(href, BASE).href.split("?")[0];
    const text = textOf($, el);
    const time = text.match(/(?<!\d)(\d{1,2})[h:](\d{2})(?!\d)/);
    out.push({
      url, day, section,
      heure: time ? `${time[1].padStart(2, "0")}:${time[2]}` : null,
      annule: /annul/i.test(text),
      complet: /complet/i.test(text),
    });
  });
  return out;
}

// ---------- 2. Fiche événement ----------
const ADDR = /\b\d{1,4}(?:\s?(?:bis|ter))?,?\s+(?:rue|avenue|av\.|cours|quai|place|all[ée]es?|boulevard|bd|impasse|chemin|route|square|parvis|esplanade|passage|rond-point)\b.{2,60}/i;

export function findAddress($, scope) {
  let found = null;
  scope.find("*").each((_, el) => {
    if (found || $(el).children().length > 2) return;
    const t = textOf($, el);
    if (t.length < 90 && ADDR.test(t)) found = t.match(ADDR)[0];
  });
  return found;
}

export function parseEvent(html, url) {
  const $ = cheerio.load(html);
  const meta = p => $(`meta[property='${p}'], meta[name='${p}']`).attr("content") ?? null;

  let ld = null; // JSON-LD schema.org Event, si présent
  $("script[type='application/ld+json']").each((_, s) => {
    try {
      const data = JSON.parse($(s).text());
      ld ??= [data, ...(data["@graph"] ?? [])].flat().find(i => /Event/.test(i?.["@type"] ?? ""));
    } catch {}
  });

  const scope = $("main").length ? $("main") : $("body");
  const venueA = scope.find("a[href*='/lieux/']").first();
  const ticketA = scope.find("a[href*='/go/']").first();
  const genres = [...new Set(scope.find("a[href*='/style/']").map((_, a) => clean($(a).text()).toLowerCase()).get())]
    .filter(g => g && g.length < 30).slice(0, 5);

  const bodyText = textOf($, scope);
  const prices = [...new Set([...bodyText.matchAll(/(\d{1,3}(?:[.,]\d{1,2})?)\s?€/g)]
    .map(m => Number(m[1].replace(",", "."))))].filter(n => n > 0 && n < 500).sort((a, b) => a - b);
  const free = /\bgratuit\b|entr[ée]e libre|prix libre/i.test(bodyText) && !prices.length;

  const ldLoc = ld?.location ?? {};
  const ldAddr = typeof ldLoc.address === "object" ? ldLoc.address : {};

  return {
    titre: clean(ld?.name || $("h1").first().text() || meta("og:title")),
    image_url: (Array.isArray(ld?.image) ? ld.image[0] : ld?.image) ?? meta("og:image"),
    venue_nom: clean(ldLoc.name || venueA.text()) || null,
    venue_url: venueA.attr("href") ? new URL(venueA.attr("href"), BASE).href : null,
    adresse: clean(ldAddr.streetAddress || (typeof ldLoc.address === "string" ? ldLoc.address : "") || findAddress($, scope)) || null,
    ville_slug: url.match(/\/evenements\/([^/]+)\//)?.[1]?.replace(/-/g, " "),
    tags: genres,
    gratuit: free,
    prix_min: prices[0] ?? null,
    prix_max: prices.at(-1) ?? null,
    lien_billetterie: ticketA.attr("href") ? new URL(ticketA.attr("href"), BASE).href.split("?")[0] : null,
  };
}

// premier mot "significatif" du titre, pour repérer un doublon venant d'une autre source
const STOP = new Set(["concert", "soiree", "live", "release", "party", "tour", "tournee", "session", "special", "invite", "avec", "nuit", "festival"]);
const matchKey = titre => norm(titre).split(" ").find(w => w.length >= 4 && !STOP.has(w)) ?? norm(titre).split(" ")[0];

// ---------- 3. Lieux : retrouver dans `venues` ou préparer la création ----------
async function geocode(q) {
  const u = `https://data.geopf.fr/geocodage/search?q=${encodeURIComponent(q)}&limit=1&lat=44.84&lon=-0.58`;
  const r = await get(u, { json: true, delay: 150 });
  const f = r?.features?.[0];
  if (!f || f.properties.score < 0.5) return null;
  const [lng, lat] = f.geometry.coordinates;
  return { lat, lng, ville: f.properties.city, adresse: f.properties.name };
}

async function resolveVenue(d, venues, cache) {
  const key = norm(d.venue_nom);
  if (!key) return null;
  if (cache.has(key)) return cache.get(key);

  const match = venues.find(v => norm(v.nom) === key)
    ?? venues.find(v => { const n = norm(v.nom); return n.length >= 5 && key.length >= 5 && (n.includes(key) || key.includes(n)); });
  if (match) { cache.set(key, { venue_id: match.id }); return cache.get(key); }

  // Lieu inconnu : adresse depuis la fiche, sinon depuis la page du lieu, puis géocodage
  let adresse = d.adresse;
  if (!adresse && d.venue_url) {
    const html = await get(d.venue_url);
    if (html) { const $ = cheerio.load(html); adresse = findAddress($, $("main").length ? $("main") : $("body")); }
  }
  const geo = (adresse && await geocode(`${adresse} ${d.ville_slug ?? ""}`)) ?? null;
  const venue = geo
    ? { nom: d.venue_nom, adresse: adresse, ville: geo.ville ?? d.ville_slug, lat: geo.lat, lng: geo.lng }
    : null; // sans coordonnées, on ne crée pas le lieu (geo est obligatoire) → événement ignoré
  if (!venue) console.warn(`⚠ lieu non géolocalisé : "${d.venue_nom}" (${adresse ?? "adresse introuvable"})`);
  cache.set(key, venue && { venue });
  return cache.get(key);
}

// ---------- 4. Orchestration ----------
async function main() {
  if (!DRY && !(SB_URL && SB_KEY)) throw new Error("SUPABASE_URL et SUPABASE_SERVICE_KEY sont requis (ou lance --dry)");

  // 4a. Agenda jour par jour → occurrences regroupées par fiche
  const byUrl = new Map();
  for (let i = 0; i < DAYS; i++) {
    const day = isoDay(i);
    const html = await get(`${BASE}/agenda/${day}/`);
    if (!html) continue;
    if (DUMP && i === 0) { await mkdir("debug", { recursive: true }); await writeFile("debug/agenda.html", html); }
    const items = parseAgenda(html, day).filter(e => !e.section || CATEGORIES.includes(e.section));
    for (const it of items) {
      const ev = byUrl.get(it.url) ?? { url: it.url, occurrences: new Map(), annule: false, complet: false };
      ev.occurrences.set(day, { date: day, heure: it.heure });
      ev.annule ||= it.annule; ev.complet ||= it.complet;
      byUrl.set(it.url, ev);
    }
    console.log(`${day} : ${items.length} ${CATEGORIES.join("/")}`);
  }

  // 4b. Lieux existants dans ta base
  const venues = SB_URL && SB_KEY ? await sb("venues?select=id,nom,ville") : [];
  const venueCache = new Map();

  // 4c. Fiches + lieux → payload pour la fonction SQL
  const payload = [];
  for (const ev of byUrl.values()) {
    const html = await get(ev.url);
    if (!html) continue;
    if (DUMP && !payload.length) await writeFile("debug/event.html", html);
    const d = parseEvent(html, ev.url);
    const v = await resolveVenue(d, venues, venueCache);
    if (!v || !d.titre) continue;
    payload.push({
      source_id: ev.url.split("/").filter(Boolean).at(-1), // ex. "chameleons-385dd79c"
      source_url: ev.url,
      titre: d.titre,
      match_key: matchKey(d.titre),
      type: EVENT_TYPE,
      tags: [...d.tags, ...(ev.complet ? ["complet"] : [])],
      gratuit: d.gratuit,
      prix_min: d.gratuit ? null : d.prix_min,
      prix_max: d.gratuit ? null : d.prix_max,
      image_url: d.image_url,
      lien_billetterie: d.lien_billetterie ?? ev.url,
      annule: ev.annule,
      ...v, // venue_id OU venue {nom, adresse, ville, lat, lng}
      occurrences: [...ev.occurrences.values()],
    });
  }
  const newVenues = new Set(payload.filter(p => p.venue).map(p => p.venue.nom));
  console.log(`→ ${payload.length} événements prêts, ${newVenues.size} nouveaux lieux : ${[...newVenues].join(", ") || "aucun"}`);

  if (DRY) { console.log(JSON.stringify(payload.slice(0, 3), null, 2)); return; }
  if (!payload.length) { console.error("⚠ 0 événement : la structure du site a peut-être changé (lance --dump)"); process.exit(1); }

  // 4d. Import par lots de 50
  const total = {};
  for (let i = 0; i < payload.length; i += 50) {
    const r = await sb("rpc/import_external_events", {
      method: "POST",
      body: { p_source: SOURCE, p_events: payload.slice(i, i + 50), p_horizon_days: DAYS },
    });
    for (const [k, n] of Object.entries(r)) total[k] = (total[k] ?? 0) + n;
  }
  console.log("✓ import terminé :", total);
}

if (import.meta.url === `file://${process.argv[1]}`) main().catch(e => { console.error(e); process.exit(1); });
