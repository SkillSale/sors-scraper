// SORS — import des spectacles theatrefemina.com (Bordeaux)
//
// Usage :
//   node scrape-theatrefemina.mjs
//   node scrape-theatrefemina.mjs --dry
//
// Listing par filtre mois Jet Engine, détail HTML pour heure / billetterie / image.

import * as cheerio from "cheerio";
import { writeFile, mkdir } from "node:fs/promises";
import {
  DAYS, DUMP, clean, get, horizonBounds, importEvents, inHorizon, loadVenues,
  matchKey, monthsInHorizon, normTime, parseFrDate, parsePrices, requireAuthUnlessDry,
  resolveFixedVenue, textOf,
} from "./lib.mjs";

const SOURCE = "theatrefemina";
const BASE = "https://theatrefemina.com";

const VENUE = {
  nom: "Théâtre Femina",
  adresse: "10 Rue de Grassi",
  ville: "Bordeaux",
  lat: 44.841362,
  lng: -0.577233,
};

export function mapType(genre = "") {
  const g = genre.toLowerCase();
  if (/concert|musical/.test(g)) return "concert";
  if (/ballet|danse|op[eé]ra/.test(g)) return "spectacle";
  return "spectacle";
}

const DATE_RE = /(?:lundi|mardi|mercredi|jeudi|vendredi|samedi|dimanche)?\s*\d{1,2}\s+(?:janvier|f[eé]vrier|mars|avril|mai|juin|juillet|ao[uû]t|septembre|octobre|novembre|d[eé]cembre)\s+\d{4}/gi;

export function parseListingCards(html) {
  const $ = cheerio.load(html);
  const byUrl = new Map();
  $(".jet-listing-grid__item").each((_, el) => {
    const href = $(el).find("a[href*='/evenement/']").first().attr("href");
    if (!href) return;
    const url = new URL(href, BASE).href.split("?")[0];
    const text = clean($(el).text());
    if (text.length < 8 || text.length > 280) return;
    // ignorer le bandeau "Ce soir : …"
    if (/^complet\s+ce soir/i.test(text)) return;

    const dates = [...text.matchAll(DATE_RE)].map(m => parseFrDate(m[0])).filter(Boolean);
    if (!dates.length) return;

    const annule = /\bannul/i.test(text);
    const complet = /^\s*complet\b/i.test(text);
    const genreM = text.match(/\b(Ballet|Cabaret|Com[eé]die(?:\s+musicale)?|Concert|Conf[eé]rence|Danse|Film|Humour|Magie|Mentalisme|Op[eé]ra|Seul en sc[eè]ne|Spectacle|Th[eé][aâ]tre)\b/i);
    const genre = genreM ? genreM[1] : null;

    let titre = text
      .replace(/\b(COMPLET|ANNUL[ÉE]*|DERNI[EÈ]RES?\s+PLACES|Offre promo)\b/gi, " ")
      .replace(DATE_RE, " ")
      .replace(/\b(Ballet|Cabaret|Com[eé]die(?:\s+musicale)?|Concert|Conf[eé]rence|Danse|Film|Humour|Magie|Mentalisme|Op[eé]ra|Seul en sc[eè]ne|Spectacle|Th[eé][aâ]tre)\b/gi, " ")
      .replace(/\s+/g, " ").trim();
    // enlève les dates collées restantes
    titre = titre.replace(/\s+/g, " ").trim();
    if (!titre || titre.length < 2) {
      titre = decodeURIComponent(url.split("/").filter(Boolean).at(-1).replace(/-/g, " "));
    }

    const prev = byUrl.get(url) ?? { url, titre, genre, dates: new Set(), annule: false, complet: false };
    for (const d of dates) prev.dates.add(d);
    prev.annule ||= annule;
    prev.complet ||= complet;
    if (genre) prev.genre = genre;
    if (titre.length > (prev.titre?.length ?? 0)) prev.titre = titre;
    byUrl.set(url, prev);
  });
  return [...byUrl.values()].map(e => ({ ...e, dates: [...e.dates].sort() }));
}

export function parseEventPage(html, url) {
  const $ = cheerio.load(html);
  const meta = p => $(`meta[property='${p}'], meta[name='${p}']`).attr("content") ?? null;
  const scope = $("main").length ? $("main") : $("body");
  const body = textOf($, scope);

  const titre = clean($("h1").first().text()) || clean(meta("og:title")?.replace(/\s*[—|].*$/, ""));
  const image_url = meta("og:image");

  // "dimanche 1 novembre 2026 à 18h00" (plusieurs dates possibles)
  const occ = new Map();
  for (const m of body.matchAll(
    /(?:lundi|mardi|mercredi|jeudi|vendredi|samedi|dimanche)?\s*(\d{1,2}\s+(?:janvier|f[eé]vrier|mars|avril|mai|juin|juillet|ao[uû]t|septembre|octobre|novembre|d[eé]cembre)\s+\d{4})\s*[àa]\s*(\d{1,2}[h:]\d{2})/gi,
  )) {
    const date = parseFrDate(m[1]);
    const heure = normTime(m[2]);
    if (date && inHorizon(date)) occ.set(`${date}|${heure}`, { date, heure });
  }
  // fallback : dates sans heure + heure isolée
  if (!occ.size) {
    const dates = [...body.matchAll(DATE_RE)].map(m => parseFrDate(m[0])).filter(d => d && inHorizon(d));
    const timeM = body.match(/\b(\d{1,2})[h:](\d{2})\b/);
    const heure = timeM ? normTime(`${timeM[1]}h${timeM[2]}`) : null;
    for (const date of [...new Set(dates)]) occ.set(`${date}|${heure}`, { date, heure });
  }

  const ticketA = scope.find("a[href*='/reserver/']").first().length
    ? scope.find("a[href*='/reserver/']").first()
    : scope.find("a[href*='dstickets.fr'][href*='reserver'], a[href*='dstickets']").filter((_, a) => /\/reserver\//.test($(a).attr("href") ?? "")).first();
  const lien = ticketA.attr("href")
    ? new URL(ticketA.attr("href"), BASE).href
    : url;

  const { gratuit, prix_min, prix_max } = parsePrices(body);
  // le bandeau site "COMPLET Ce soir : …" pollue le body → on se fie surtout au listing
  const h1Block = clean($("h1").first().parent().text()).slice(0, 200);
  const annule = /\bannul/i.test(h1Block);

  return {
    titre,
    image_url,
    lien_billetterie: lien,
    occurrences: [...occ.values()],
    gratuit,
    prix_min,
    prix_max,
    annule,
    complet: false,
  };
}

async function collectFromMonths() {
  const months = monthsInHorizon();
  console.log(`mois ciblés : ${months.join(", ")}`);
  const byUrl = new Map();
  for (const mois of months) {
    const html = await get(`${BASE}/evenements/filtres/categorie/mois:${mois}/`);
    if (!html) continue;
    if (DUMP && mois === months[0]) {
      await mkdir("debug", { recursive: true });
      await writeFile("debug/femina-month.html", html);
    }
    const cards = parseListingCards(html);
    for (const c of cards) {
      const prev = byUrl.get(c.url);
      if (!prev) { byUrl.set(c.url, c); continue; }
      prev.dates = [...new Set([...prev.dates, ...c.dates])].sort();
      prev.annule ||= c.annule;
      prev.complet ||= c.complet;
      if (c.genre) prev.genre = c.genre;
    }
    console.log(`  ${mois} : ${cards.length} cartes`);
  }
  return [...byUrl.values()].filter(e => e.dates.some(d => inHorizon(d)));
}

async function main() {
  requireAuthUnlessDry();
  const { from, to } = horizonBounds();
  console.log(`Théâtre Femina — horizon ${from} → ${to}`);

  const listed = await collectFromMonths();
  console.log(`→ ${listed.length} événements listés dans l'horizon`);

  const venues = await loadVenues();
  const venueRef = await resolveFixedVenue(VENUE, venues, new Map());

  const payload = [];
  for (const item of listed) {
    const html = await get(item.url);
    if (!html) continue;
    if (DUMP && !payload.length) await writeFile("debug/femina-event.html", html);
    const d = parseEventPage(html, item.url);
    const titre = d.titre || item.titre;
    let occurrences = d.occurrences.filter(o => inHorizon(o.date));
    // si la fiche n'a pas d'heure, reprendre les dates listing
    if (!occurrences.length) {
      occurrences = item.dates.filter(inHorizon).map(date => ({ date, heure: null }));
    } else {
      // fusionner dates listing manquantes
      const have = new Set(occurrences.map(o => o.date));
      for (const date of item.dates) {
        if (inHorizon(date) && !have.has(date)) occurrences.push({ date, heure: null });
      }
    }
    if (!occurrences.length || !titre) continue;

    const tags = [item.genre].filter(Boolean).map(s => s.toLowerCase());
    if (item.complet || d.complet) tags.push("complet");

    payload.push({
      source_id: item.url.split("/").filter(Boolean).at(-1),
      source_url: item.url,
      titre,
      match_key: matchKey(titre),
      type: mapType(item.genre || ""),
      tags,
      gratuit: d.gratuit,
      prix_min: d.gratuit ? null : d.prix_min,
      prix_max: d.gratuit ? null : d.prix_max,
      image_url: d.image_url,
      lien_billetterie: d.lien_billetterie || item.url,
      annule: item.annule || d.annule,
      ...venueRef,
      occurrences,
    });
  }

  console.log(`→ ${payload.length} événements prêts`);
  await importEvents(SOURCE, payload);
}

if (import.meta.url === `file://${process.argv[1]}`) main().catch(e => { console.error(e); process.exit(1); });
