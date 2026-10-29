// SORS — import des concerts / spectacles arkeaarena.com (Floirac)
//
// Usage :
//   node scrape-arkeaarena.mjs
//   node scrape-arkeaarena.mjs --dry
//
// API Strapi publique : https://content.arkeaarena.com/api/events

import { writeFile, mkdir } from "node:fs/promises";
import {
  DAYS, DUMP, get, horizonBounds, importEvents, inHorizon, loadVenues,
  matchKey, normTime, requireAuthUnlessDry, resolveFixedVenue,
} from "./lib.mjs";

const SOURCE = "arkeaarena";
const API = "https://content.arkeaarena.com/api/events";
const SITE = "https://www.arkeaarena.com";
const MEDIA = "https://content.arkeaarena.com";

const VENUE = {
  nom: "Arkéa Arena",
  adresse: "48-50 Boulevard Joliot Curie",
  ville: "Floirac",
  lat: 44.835429,
  lng: -0.53283,
};

export function mapType(genre = "") {
  return /concert/i.test(genre) ? "concert" : "spectacle";
}

export function mediaUrl(img) {
  const path = img?.url ?? (typeof img === "string" ? img : null);
  if (!path) return null;
  return path.startsWith("http") ? path : `${MEDIA}${path}`;
}

function apiUrl(page, pageSize, from) {
  const u = new URL(API);
  u.searchParams.set("pagination[page]", String(page));
  u.searchParams.set("pagination[pageSize]", String(pageSize));
  u.searchParams.set("populate", "sessions,square_image,tags");
  u.searchParams.set("filters[sessions][date][$gte]", from);
  u.searchParams.set("sort", "id:desc");
  return u.href;
}

export async function fetchUpcoming(from) {
  const all = [];
  let page = 1;
  let pageCount = 1;
  while (page <= pageCount) {
    const data = await get(apiUrl(page, 100, from), { json: true, delay: 400 });
    if (!data?.data) break;
    all.push(...data.data);
    pageCount = data.meta?.pagination?.pageCount ?? 1;
    page += 1;
  }
  return all;
}

export function eventToPayload(e, venueRef, to) {
  const sessions = (e.sessions ?? []).filter(s => {
    const d = (s.date ?? "").slice(0, 10);
    return d && inHorizon(d) && d <= to;
  });
  if (!sessions.length) return null;

  const titre = (e.title ?? "").replace(/\s*[-–]\s*\d{1,2}\s+\S+\s+\d{4}.*$/i, "").trim()
    || e.title;
  if (!titre) return null;

  const tags = [
    e.genre,
    ...(e.tags ?? []).map(t => t.name).filter(Boolean),
  ].filter(Boolean).map(s => String(s).toLowerCase()).slice(0, 6);

  const soldOut = sessions.every(s => /SOLD|UNAVAILABLE|COMPLET/i.test(s.availability ?? ""));
  const cancelled = sessions.some(s => /CANCEL/i.test(s.availability ?? ""));
  if (soldOut) tags.push("complet");

  const ticket = sessions.find(s => s.ticketmaster_link)?.ticketmaster_link
    || e.ticketmaster_link
    || `${SITE}/evenements/${e.slug}`;

  return {
    source_id: String(e.documentId || e.id),
    source_url: `${SITE}/evenements/${e.slug}`,
    titre,
    match_key: matchKey(titre),
    type: mapType(e.genre),
    tags: [...new Set(tags)],
    gratuit: false,
    prix_min: null,
    prix_max: null,
    image_url: mediaUrl(e.square_image),
    lien_billetterie: ticket,
    annule: cancelled,
    ...venueRef,
    occurrences: sessions.map(s => ({
      date: s.date.slice(0, 10),
      heure: normTime(s.time),
    })),
  };
}

async function main() {
  requireAuthUnlessDry();
  const { from, to } = horizonBounds();
  console.log(`Arkéa Arena — horizon ${from} → ${to}`);

  const events = await fetchUpcoming(from);
  console.log(`→ ${events.length} événements API (sessions ≥ ${from})`);
  if (DUMP) {
    await mkdir("debug", { recursive: true });
    await writeFile("debug/arkea-api-sample.json", JSON.stringify(events.slice(0, 2), null, 2));
  }

  const venues = await loadVenues();
  const venueRef = await resolveFixedVenue(VENUE, venues, new Map());

  const payload = [];
  for (const e of events) {
    const p = eventToPayload(e, venueRef, to);
    if (p) payload.push(p);
  }
  console.log(`→ ${payload.length} événements dans l'horizon ${DAYS}j`);
  await importEvents(SOURCE, payload);
}

if (import.meta.url === `file://${process.argv[1]}`) main().catch(e => { console.error(e); process.exit(1); });
