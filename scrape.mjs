#!/usr/bin/env node
/**
 * Roland Richardson — Squarespace art scraper
 * -------------------------------------------
 * Pulls every artwork (titles, prices, options, ALL image URLs, descriptions)
 * from rolandrichardson.com using Squarespace's built-in JSON feed (?format=json),
 * then writes:
 *   output/artworks.ts      -> drop into the Lovable project at src/content/artworks.ts
 *   output/catalogs.ts      -> drop into src/content/catalogs.ts (cover images filled in)
 *   output/review-sheet.csv -> for the catalog lead to verify (open in Excel / Google Sheets)
 *   output/raw/             -> raw JSON for every page, for debugging
 *   output/images/          -> (optional) full-resolution copies of every image
 *
 * Requirements: Node 18 or newer. No npm install needed.
 * Run:          node scrape.mjs
 * With images:  node scrape.mjs --download-images
 */

import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

const SITE = "https://www.rolandrichardson.com";
const OUT = "output";
const DOWNLOAD_IMAGES = process.argv.includes("--download-images");
const DELAY_MS = Number(process.env.DELAY_MS ?? 1500); // be polite: one request every 1.5s so the site doesn't block us

// The 7 catalogs on /art-catalogs. "slug" matches catalogs.ts in the Lovable project.
const CATALOGS = [
  { slug: "limited-editions",     title: "Limited Editions",     path: "/art-limited-editions" },
  { slug: "small-original-oils",  title: "Small Original Oils",  path: "/small-originals" },
  { slug: "fine-print-making",    title: "Fine Print Making",    path: "/art-fine-print-making" },
  { slug: "watercolors",          title: "Watercolors",          path: "/art-original-watercolor" },
  { slug: "original-oils",        title: "Original Oils",        path: "/artoriginals" },
  { slug: "drawings",             title: "Drawings",             path: "/art-drawings" },
  { slug: "private-collection",   title: "Private Collection",   path: "/private-collection" },
];

// Store collections we already know about. More are discovered automatically
// from product links found on the catalog pages.
const KNOWN_STORES = ["original", "watercolor", "limited-editions"];

// Paths that are never artwork stores.
const NOT_STORES = new Set([
  "", "cart", "search", "blog", "artblog", "art-catalog", "contact", "events", "videos",
  "about-the-artist", "art-catalogs", "gift-certificates", "art-exhibits", "photo-album-1",
  "poetryhome", "youtube-videos", "s", "static", "content", "commerce", "api", "account",
]);

// ---------------------------------------------------------------- helpers
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function getJSON(path) {
  const url = SITE + path + (path.includes("?") ? "&" : "?") + "format=json";
  for (let attempt = 1; attempt <= 3; attempt++) {
    await sleep(DELAY_MS * attempt);
    try {
      const res = await fetch(url, {
        headers: { "User-Agent": "Mozilla/5.0 (site migration; contact laura@rolandrichardson.com)" },
      });
      if (res.status === 404) return null;
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const text = await res.text();
      try { return JSON.parse(text); }
      catch { return null; } // page doesn't support JSON (not a Squarespace collection/page)
    } catch (e) {
      console.warn(`  ! ${path} attempt ${attempt} failed: ${e.message}`);
    }
  }
  return null;
}

const safeName = (s) => s.replace(/[^a-z0-9-_]+/gi, "_").slice(0, 80);

function stripHtml(html = "") {
  return html
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/(p|h[1-6]|li|div)>/gi, "\n\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/g, " ").replace(/&amp;/g, "&").replace(/&quot;/g, '"')
    .replace(/&#39;|&rsquo;|&lsquo;/g, "'").replace(/&ldquo;|&rdquo;/g, '"')
    .replace(/&ndash;/g, "–").replace(/&mdash;/g, "—").replace(/&hellip;/g, "…")
    .replace(/[ \t]+/g, " ")
    .split(/\n{2,}/).map((p) => p.replace(/\n/g, " ").trim()).filter(Boolean);
}

// Full-resolution version of a Squarespace image URL
const fullRes = (u) => (u ? u.split("?")[0] + "?format=2500w" : u);
const cleanImg = (u) => (u ? u.split("?")[0] : u);

// Squarespace has shipped two price formats over the years — handle both.
function variantPrice(v) {
  if (v?.priceMoney?.value != null) return Number(v.priceMoney.value);
  if (v?.salePriceMoney?.value && v.onSale) return Number(v.salePriceMoney.value);
  if (typeof v?.price === "number") return v.price / 100; // older format: cents
  return undefined;
}

function variantLabel(v) {
  const attrs = v?.attributes ? Object.values(v.attributes).filter(Boolean) : [];
  if (attrs.length) return attrs.join(" / ");
  return v?.optionValues?.map((o) => o.value).join(" / ") || "Standard";
}

// Pull "Medium / Size / Date / Location" style facts out of the description text.
function guessFacts(paragraphs) {
  const text = paragraphs.join(" \n ");
  const facts = {};
  const dim = text.match(/(\d+(?:\.\d+)?\s*["”]?\s*[x×]\s*\d+(?:\.\d+)?\s*["”]?(?:\s*(?:inches|in\.?))?)/i);
  if (dim) facts.dimensions = dim[1].replace(/\s+/g, " ").trim();
  const yr = text.match(/\b(19[5-9]\d|20[0-3]\d)\b/);
  if (yr) facts.year = Number(yr[1]);
  const date = text.match(/\b(January|February|March|April|May|June|July|August|September|October|November|December)\s+(19|20)\d{2}\b/);
  if (date) facts.dateCreated = date[0];
  const med = text.match(/(original\s+(?:oil|watercolou?r|pastel|charcoal|drawing)[^.,;\n]{0,60}|hand[- ]pulled[^.,;\n]{0,60}|(?:limited[- ]edition\s+)?gicl[eé]e[^.,;\n]{0,60}|etching[^.,;\n]{0,40}|watercolou?r on [^.,;\n]{0,40}|oil on [^.,;\n]{0,40})/i);
  if (med) facts.medium = med[1].trim().replace(/^./, (c) => c.toUpperCase());
  if (/\bsold\b/i.test(text)) facts.mentionsSold = true;
  return facts;
}

// Find product links like /original/plum-bay or /watercolor/sunflower-sunshine in HTML
function findProductLinks(html = "") {
  const links = new Set();
  const re = /href="(?:https?:\/\/(?:www\.)?rolandrichardson\.com)?\/([a-z0-9-]+)\/([a-z0-9-]+)\/?"/gi;
  let m;
  while ((m = re.exec(html))) {
    const [, store, slug] = m;
    if (!NOT_STORES.has(store.toLowerCase())) links.add(`${store.toLowerCase()}/${slug.toLowerCase()}`);
  }
  return [...links];
}

// Find "see all" style links (e.g. /small-originals-all) on a catalog page
function findSeeAllLinks(html = "", catalogPath) {
  const out = new Set();
  const base = catalogPath.replace(/^\//, "");
  const re = /href="(?:https?:\/\/(?:www\.)?rolandrichardson\.com)?\/([a-z0-9-]+)\/?"/gi;
  let m;
  while ((m = re.exec(html))) {
    const p = m[1].toLowerCase();
    if (p !== base && (p.startsWith(base) || /-all$/.test(p))) out.add("/" + p);
  }
  return [...out];
}

function firstImage(html = "") {
  const m = html.match(/(?:data-src|data-image|src)="(https:\/\/images\.squarespace-cdn\.com\/[^"]+)"/i);
  return m ? cleanImg(m[1]) : undefined;
}

// ---------------------------------------------------------------- main
async function main() {
  await mkdir(join(OUT, "raw"), { recursive: true });
  console.log("Roland Richardson scraper — starting\n");

  // 1) Catalog pages: which artworks are in which catalog, plus cover images
  const membership = new Map(); // "store/slug" -> Set(catalogSlug)
  const featured = new Set();    // "store/slug" shown on the curated (first) page
  const stores = new Set(KNOWN_STORES);
  const catalogsOut = [];

  // Cover images: the /art-catalogs page tiles
  const landing = await getJSON("/art-catalogs");
  if (landing) await writeFile(join(OUT, "raw", "art-catalogs.json"), JSON.stringify(landing, null, 2));
  const landingHtml = landing?.mainContent || "";

  for (const cat of CATALOGS) {
    console.log(`Catalog: ${cat.title} (${cat.path})`);
    const page = await getJSON(cat.path);
    if (!page) { console.warn("  ! could not load"); catalogsOut.push({ ...cat }); continue; }
    await writeFile(join(OUT, "raw", `catalog_${cat.slug}.json`), JSON.stringify(page, null, 2));
    const html = page.mainContent || "";

    const curated = findProductLinks(html);
    curated.forEach((k) => { featured.add(k); });
    let all = [...curated];

    for (const extra of findSeeAllLinks(html, cat.path)) {
      console.log(`  + also reading ${extra}`);
      const p2 = await getJSON(extra);
      if (p2) {
        await writeFile(join(OUT, "raw", `catalog_${cat.slug}_${safeName(extra)}.json`), JSON.stringify(p2, null, 2));
        all.push(...findProductLinks(p2.mainContent || ""));
      }
    }
    all = [...new Set(all)];
    all.forEach((k) => {
      stores.add(k.split("/")[0]);
      if (!membership.has(k)) membership.set(k, new Set());
      membership.get(k).add(cat.slug);
    });

    // Cover image: tile on landing page near this catalog's link, else first image on the catalog page
    const tileRe = new RegExp(`href="[^"]*${cat.path}"[\\s\\S]{0,1500}?(?:data-src|src)="(https://images\\.squarespace-cdn\\.com/[^"]+)"`, "i");
    const tileRe2 = new RegExp(`(?:data-src|src)="(https://images\\.squarespace-cdn\\.com/[^"]+)"[\\s\\S]{0,1500}?href="[^"]*${cat.path}"`, "i");
    const cover = cleanImg((landingHtml.match(tileRe) || landingHtml.match(tileRe2) || [])[1]) || firstImage(html);

    const seo = page.collection?.seoData || page.website?.seoData || {};
    catalogsOut.push({
      ...cat,
      coverImage: cover,
      intro: stripHtml(html).slice(0, 4).filter((t) => t.length > 30 && t.length < 600),
      metaDescription: seo.seoDescription || page.collection?.description || undefined,
    });
    console.log(`  ${all.length} artwork links found`);
  }

  // 2) Every store collection: full product data
  const products = new Map(); // "store/slug" -> product item
  for (const store of stores) {
    console.log(`\nStore: /${store}`);
    let path = `/${store}`;
    let pageNum = 0;
    while (path && pageNum < 50) {
      pageNum++;
      const data = await getJSON(path);
      if (!data?.items) { console.log("  (no product feed here)"); break; }
      await writeFile(join(OUT, "raw", `store_${safeName(store)}_p${pageNum}.json`), JSON.stringify(data, null, 2));
      for (const item of data.items) {
        const key = `${store}/${(item.urlId || "").toLowerCase()}`;
        products.set(key, item);
      }
      console.log(`  page ${pageNum}: ${data.items.length} items`);
      const next = data.pagination?.nextPageUrl;
      path = data.pagination?.nextPage && next ? next.replace(SITE, "") : null;
    }
  }

  // 3) Any artwork linked from a catalog but not in a store feed: fetch it directly
  for (const key of membership.keys()) {
    if (products.has(key)) continue;
    console.log(`Fetching single item /${key}`);
    const data = await getJSON(`/${key}`);
    if (data?.item) products.set(key, data.item);
    else console.warn(`  ! could not load /${key} (review manually)`);
  }

  // 4) Convert to the Lovable Artwork format
  const artworks = [];
  const usedSlugs = new Set();
  for (const [key, item] of products) {
    const [store, urlSlug] = key.split("/");
    const paragraphs = stripHtml(item.body || item.excerpt || "");
    const facts = guessFacts(paragraphs);
    const variants = (item.variants || [])
      .map((v) => ({
        label: variantLabel(v),
        price: variantPrice(v),
        available: v.unlimited ? true : (v.qtyInStock ?? 1) > 0,
      }))
      .filter((v) => v.price != null);

    const images = (item.items?.length ? item.items : [{ assetUrl: item.assetUrl }])
      .filter((i) => i?.assetUrl)
      .map((i, n) => ({ src: fullRes(i.assetUrl), alt: n === 0 ? `${item.title} by Sir Roland Richardson` : `${item.title}, detail ${n + 1}` }));

    const isEdition = /limited|giclee|edition|print/.test(store);
    const prices = variants.map((v) => v.price);
    const allSoldOut = variants.length > 0 && variants.every((v) => v.available === false);
    const cats = [...(membership.get(key) || [])];

    // keep the original store in the URL so live links keep working (/original/x, /watercolor/x ...)
    let slug = urlSlug;
    if (usedSlugs.has(`${store}/${slug}`)) slug = `${slug}-${store}`;
    usedSlugs.add(`${store}/${slug}`);

    artworks.push({
      slug,
      urlPrefix: store,                       // URL = /{urlPrefix}/{slug}, identical to the live site
      title: item.title,
      type: isEdition ? "limited-edition" : "original",
      catalogs: cats.length ? cats : ["uncategorized"],
      featured: featured.has(key) || undefined,
      medium: facts.medium,
      dimensions: facts.dimensions,
      dateCreated: facts.dateCreated,
      year: facts.year,
      description: paragraphs,
      images,
      price: variants.length === 1 ? prices[0] : undefined,
      priceOnRequest: prices.length === 0 ? true : undefined,
      status: allSoldOut || facts.mentionsSold ? "sold" : "available",
      variants: variants.length > 1 ? variants : undefined,
      internal: { notes: `Imported from ${SITE}/${key}. Check medium/size/date/status.` },
    });
  }
  artworks.sort((a, b) => a.title.localeCompare(b.title));

  // 5) Optional: download images
  if (DOWNLOAD_IMAGES) {
    await mkdir(join(OUT, "images"), { recursive: true });
    console.log(`\nDownloading images...`);
    for (const a of artworks) {
      for (const [n, img] of a.images.entries()) {
        try {
          await sleep(400);
          const res = await fetch(img.src);
          if (!res.ok) throw new Error(`HTTP ${res.status}`);
          const ext = (img.src.split("?")[0].match(/\.(jpe?g|png|webp|gif)$/i) || [, "jpg"])[1].toLowerCase();
          const file = `${a.urlPrefix}__${a.slug}${n ? `__${n + 1}` : ""}.${ext}`;
          await writeFile(join(OUT, "images", file), Buffer.from(await res.arrayBuffer()));
          img.localFile = `images/${file}`;
        } catch (e) { console.warn(`  ! ${a.title} image ${n + 1}: ${e.message}`); }
      }
    }
  }

  // 6) Write outputs
  const header = `// Generated by scrape.mjs on ${new Date().toISOString().slice(0, 10)} from ${SITE}\n// Review with the catalog lead before launch. Fields marked in internal.notes were guessed from description text.\n\n`;
  await writeFile(join(OUT, "artworks.ts"),
    header + `import type { Artwork } from "@/lib/artworks";\n\nexport const artworks: Artwork[] = ${JSON.stringify(artworks, null, 2)};\n`);
  await writeFile(join(OUT, "artworks.json"), JSON.stringify(artworks, null, 2));
  await writeFile(join(OUT, "catalogs.json"), JSON.stringify(catalogsOut, null, 2));
  await writeFile(join(OUT, "catalogs.ts"),
    header + `export const catalogs = ${JSON.stringify(catalogsOut.map((c, i) => ({ ...c, order: i + 1 })), null, 2)};\n`);

  // Review sheet for the catalog lead
  const esc = (v) => `"${String(v ?? "").replace(/"/g, '""')}"`;
  const rows = [["Preview", "Title", "Live page", "Image URL", "Catalogs", "Medium", "Dimensions", "Date", "Price (USD)", "Options & prices", "Status", "Correct? (Y/N)", "Corrections / notes"]];
  for (const a of artworks) {
    rows.push([
      a.images[0] ? `=IMAGE("${a.images[0].src.replace("2500w", "300w")}")` : "", a.title, `${SITE}/${a.urlPrefix}/${a.slug}`, a.images[0]?.src, a.catalogs.join(", "),
      a.medium, a.dimensions, a.dateCreated || a.year, a.price ?? (a.priceOnRequest ? "On request" : ""),
      (a.variants || []).map((v) => `${v.label}: $${v.price}`).join(" | "), a.status, "", "",
    ]);
  }
  await writeFile(join(OUT, "review-sheet.csv"), "﻿" + rows.map((r) => r.map(esc).join(",")).join("\n"));

  // Summary
  const noImg = artworks.filter((a) => !a.images.length).length;
  const noCat = artworks.filter((a) => a.catalogs[0] === "uncategorized").length;
  console.log(`\nDone.
  Artworks:            ${artworks.length}
  Images found:        ${artworks.reduce((n, a) => n + a.images.length, 0)}
  Missing images:      ${noImg}
  Not in any catalog:  ${noCat}  (marked "uncategorized"; decide where they belong)
  Stores scanned:      ${[...stores].join(", ")}
Files are in ./${OUT}/`);
}

main().catch((e) => { console.error(e); process.exit(1); });
