import { NextRequest, NextResponse } from "next/server";
import * as cheerio from "cheerio";
import { getAnyCachedValue, getCachedValue, setCachedValue } from "@/lib/server-cache";

type MenuHit = {
  itemName: string;
  description: string;
  itemText: string;
  price: string;
  sourceUrl: string;
  sourceType?: string;
};

type QueryIntent = {
  coreTokens: string[];
  dietaryTokens: string[];
};

type Place = {
  displayName?: { text?: string };
  formattedAddress?: string;
  rating?: number;
  currentOpeningHours?: { openNow?: boolean };
  websiteUri?: string;
  googleMapsUri?: string | null;
  location?: { latitude?: number; longitude?: number };
};

type SearchResult = {
  restaurantName: string;
  address: string;
  rating?: number;
  openNow?: boolean;
  dish: string;
  itemName: string;
  price: string;
  description: string;
  sourceType: string;
  sourceUrl: string;
  websiteUrl: string;
  googleMapsUrl?: string | null;
  distanceMiles?: number;
};

type SearchResponsePayload = {
  results: SearchResult[];
  note: string;
  cachedAt?: string;
};

const CACHE_DAYS = 30;
const CACHE_VERSION = "v19";
const FETCH_TIMEOUT_MS = 8000;
const SITE_CHECK_BATCH_SIZE = 4;
const MAX_CANDIDATE_RESTAURANTS = 15;

function absoluteUrl(base: string, href: string) {
  try {
    return new URL(href, base).toString();
  } catch {
    return "";
  }
}

function normalize(s: string) {
  return s
    .replace(/([a-z])([A-Z])/g, "$1 $2")
    .replace(/&/g, " ")
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim();
}

function tokenize(s: string) {
  return normalize(s)
    .replace(/[^a-z0-9\s]/g, " ")
    .split(" ")
    .map((part) => part.trim())
    .filter(Boolean);
}

function singularize(word: string) {
  if (word.endsWith("ies") && word.length > 3) return `${word.slice(0, -3)}y`;
  if (word.endsWith("es") && word.length > 3) return word.slice(0, -2);
  if (word.endsWith("s") && word.length > 2) return word.slice(0, -1);
  return word;
}

const DIETARY_TERMS = new Set(["vegetarian", "veggie", "vegan"]);
const MEAT_TERMS = new Set([
  "beef",
  "steak",
  "chicken",
  "pork",
  "bacon",
  "ham",
  "turkey",
  "salami",
  "pepperoni",
  "sausage",
  "lamb",
  "shrimp",
  "fish",
  "carnitas",
  "chorizo",
]);
const VEGETARIAN_SIGNALS = new Set([
  "vegetarian",
  "veggie",
  "vegan",
  "tofu",
  "plantain",
  "mushroom",
  "beans",
  "bean",
  "cheese",
  "avocado",
  "guacamole",
  "sofritas",
  "falafel",
  "eggplant",
  "cauliflower",
  "spinach",
]);
const FLEXIBLE_PROTEIN_PHRASES = [
  "choice of meat",
  "choice of protein",
  "your choice of meat",
  "your choice of protein",
];
const MEAT_SUBSTITUTE_PHRASES = [
  "fake chicken",
  "vegan chicken",
  "vegetarian chicken",
  "plant based chicken",
  "plant-based chicken",
  "meatless chicken",
  "meat free chicken",
  "mock chicken",
  "impossible chicken",
  "beyond chicken",
];
const MEAT_SUBSTITUTE_SIGNALS = new Set([
  "fake",
  "vegan",
  "vegetarian",
  "veggie",
  "plant",
  "based",
  "meatless",
  "meat",
  "free",
  "mock",
  "impossible",
  "beyond",
  "soy",
  "soyrizo",
]);

function parseQueryIntent(query: string): QueryIntent {
  const normalizedQuery = tokenize(query).map((token) => singularize(token));
  return {
    coreTokens: normalizedQuery.filter((token) => !DIETARY_TERMS.has(token)),
    dietaryTokens: normalizedQuery.filter((token) => DIETARY_TERMS.has(token)),
  };
}

function buildTokenForms(text: string) {
  const forms = new Set<string>();
  for (const token of tokenize(text)) {
    forms.add(token);
    forms.add(singularize(token));
  }
  return forms;
}

function hasMeatSubstituteContext(text: string, term?: string) {
  const normalized = ` ${normalize(text)} `;
  const forms = buildTokenForms(text);

  if (MEAT_SUBSTITUTE_PHRASES.some((phrase) => normalized.includes(` ${phrase} `))) {
    return true;
  }

  if (term) {
    const meatToken = singularize(term);
    if (!forms.has(meatToken) && !normalized.includes(` ${meatToken} `)) {
      return false;
    }
  }

  return Array.from(MEAT_SUBSTITUTE_SIGNALS).some((signal) => forms.has(singularize(signal)));
}

function isVegetarianCompatible(text: string) {
  const normalized = ` ${normalize(text)} `;
  const forms = buildTokenForms(text);
  const hasFlexibleProteinChoice = FLEXIBLE_PROTEIN_PHRASES.some((phrase) =>
    normalized.includes(` ${phrase} `)
  );
  const hasMeat = Array.from(MEAT_TERMS).some((term) => {
    const token = singularize(term);
    if (!(forms.has(token) || normalized.includes(` ${token} `))) return false;
    return !hasMeatSubstituteContext(text, term);
  });
  if (hasMeat && !hasFlexibleProteinChoice) return false;
  return Array.from(VEGETARIAN_SIGNALS).some((term) => forms.has(singularize(term)));
}

function containsExplicitMeat(text: string) {
  const normalized = ` ${normalize(text)} `;
  const forms = buildTokenForms(text);

  return Array.from(MEAT_TERMS).some((term) => {
    const token = singularize(term);
    if (!(forms.has(token) || normalized.includes(` ${token} `))) return false;
    return !hasMeatSubstituteContext(text, term);
  });
}

function shouldKeepResultForQuery(result: SearchResult, query: string) {
  const { dietaryTokens } = parseQueryIntent(query);
  if (dietaryTokens.length === 0) return true;

  const visibleText = [result.itemName, result.description].filter(Boolean).join(" ");
  const combinedText = [
    visibleText,
    result.itemName,
    result.description,
    result.dish,
    result.sourceUrl,
  ]
    .filter(Boolean)
    .join(" ");

  const normalized = ` ${normalize(combinedText)} `;
  const hasFlexibleProteinChoice = FLEXIBLE_PROTEIN_PHRASES.some((phrase) =>
    normalized.includes(` ${phrase} `)
  );
  const hasVisibleExplicitMeat = containsExplicitMeat(visibleText);

  if (hasVisibleExplicitMeat) {
    return false;
  }

  const hasExplicitMeat = containsExplicitMeat(combinedText);
  if (hasExplicitMeat && !hasFlexibleProteinChoice) return false;

  return isVegetarianCompatible(combinedText);
}

function queryMatchesText(query: string, text: string) {
  const textForms = buildTokenForms(text);
  if (textForms.size === 0) return false;

  const { coreTokens, dietaryTokens } = parseQueryIntent(query);

  const hasCoreMatch =
    coreTokens.length === 0 || coreTokens.every((token) => textForms.has(token));
  if (!hasCoreMatch) return false;

  if (dietaryTokens.length === 0) return true;

  return dietaryTokens.every((token) => {
    if (token === "vegetarian" || token === "veggie" || token === "vegan") {
      return isVegetarianCompatible(text);
    }
    return textForms.has(token);
  });
}

function queryMatchesContext(query: string, primaryText: string, contextText: string) {
  const { coreTokens, dietaryTokens } = parseQueryIntent(query);
  const primaryForms = buildTokenForms(primaryText);
  const contextForms = buildTokenForms(contextText);

  const hasCoreMatch =
    coreTokens.length === 0 ||
    coreTokens.every((token) => primaryForms.has(token) || contextForms.has(token));
  if (!hasCoreMatch) return false;

  if (dietaryTokens.length === 0) return true;

  return dietaryTokens.every((token) => {
    if (token === "vegetarian" || token === "veggie" || token === "vegan") {
      return isVegetarianCompatible(`${primaryText} ${contextText}`);
    }
    return primaryForms.has(token) || contextForms.has(token);
  });
}

function likelyCategoryLabel(line: string) {
  const l = normalize(line);
  const bad = [
    "appetizers",
    "sides",
    "drinks",
    "beverages",
    "desserts",
    "salads",
    "soups",
    "burgers",
    "sandwiches",
    "tacos",
    "burritos",
    "entrees",
    "mains",
    "combos",
    "specials",
    "menu",
  ];
  return bad.includes(l);
}

function cleanDisplayText(text: string) {
  return text
    .replace(/([a-z])([A-Z])/g, "$1 $2")
    .replace(/\s+/g, " ")
    .trim();
}

function deriveItemNameAndDescription(raw: string, dishQuery: string, currentHeading: string) {
  const cleaned = cleanDisplayText(raw).replace(/\s*\$\s?\d{1,3}(?:\.\d{2})?\s*/g, " ").trim();
  const intent = parseQueryIntent(dishQuery);

  let splitIndex = -1;
  for (const token of intent.coreTokens) {
    const pattern = new RegExp(`\\b${token}s?\\b`, "ig");
    let match: RegExpExecArray | null;
    while ((match = pattern.exec(cleaned)) !== null) {
      splitIndex = Math.max(splitIndex, match.index + match[0].length);
    }
  }

  let itemName = cleaned;
  let description = "";

  if (splitIndex > 0 && splitIndex < cleaned.length) {
    itemName = cleaned.slice(0, splitIndex).trim();
    description = cleaned.slice(splitIndex).replace(/^[\s,:.-]+/, "").trim();
  }

  if (!itemName || itemName.startsWith("$")) {
    itemName = "";
  }

  if (!description && currentHeading) {
    description = `Section: ${cleanDisplayText(currentHeading)}`;
  }

  return { itemName, description, cleaned };
}

function extractMenuHitsFromHtml(html: string, dishQuery: string, sourceUrl: string): MenuHit[] {
  const $ = cheerio.load(html);
  const hits: MenuHit[] = [];
  const seen = new Set<string>();
  let currentHeading = "";
  const queryIntent = parseQueryIntent(dishQuery);

  $("h1, h2, h3, h4, h5, h6, article, section, li, p, div, span, td").each((_, el) => {
    const raw = $(el).text().replace(/\s+/g, " ").trim();
    if (!raw || raw.length < 2 || raw.length > 360) return;

    const tag = el.tagName?.toLowerCase() || "";
    const normalized = normalize(raw);

    if (tag.startsWith("h")) {
      currentHeading = normalized;
      return;
    }

    const priceMatches = raw.match(/\$\s?\d{1,3}(?:\.\d{2})?/g);
    if (!priceMatches || priceMatches.length !== 1) return;
    if (likelyCategoryLabel(normalized)) return;

    const lineMatches = queryMatchesText(dishQuery, raw);
    const headingMatches = currentHeading ? queryMatchesText(dishQuery, currentHeading) : false;
    if (!lineMatches && !headingMatches) return;

    const { itemName, description, cleaned } = deriveItemNameAndDescription(raw, dishQuery, currentHeading);
    if (!itemName) return;
    if (likelyCategoryLabel(itemName)) return;
    if (
      queryIntent.dietaryTokens.length > 0 &&
      !isVegetarianCompatible(`${currentHeading} ${itemName} ${description} ${cleaned}`)
    ) {
      return;
    }

    const price = priceMatches[0].replace(/\s+/g, "");
    const itemText = headingMatches && !lineMatches ? `${cleaned} (${currentHeading})` : cleaned;
    const key = `${normalize(itemText)}|${price}`;
    if (seen.has(key)) return;
    seen.add(key);

    hits.push({
      itemName,
      description,
      itemText,
      price,
      sourceUrl,
      sourceType:
        sourceUrl.includes("toasttab.com")
          ? "toast_ordering"
          : sourceUrl.includes("spoton.com")
            ? "spoton_ordering"
            : "website_or_ordering_page",
    });
  });

  return hits;
}

function parseSequentialMenuHits(html: string, dishQuery: string, sourceUrl: string): MenuHit[] {
  const $ = cheerio.load(html);
  const queryIntent = parseQueryIntent(dishQuery);
  const rawLines = $("body")
    .text()
    .split("\n")
    .map((line) => cleanDisplayText(line))
    .filter(Boolean);

  const lines = rawLines.filter((line) => line.length > 1 && line.length < 220);
  const hits: MenuHit[] = [];
  const seen = new Set<string>();
  let currentHeading = "";
  let recentContext = "";

  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    const normalized = normalize(line);

    if (likelyCategoryLabel(normalized)) {
      currentHeading = normalized;
      recentContext = normalized;
      continue;
    }

    if (queryMatchesText(dishQuery, line) && !/\d/.test(line)) {
      currentHeading = normalized;
      recentContext = normalized;
    }

    if (!/^\d{1,2}(?:\.\d{2})?$/.test(line) && line.length < 80) {
      recentContext = `${recentContext} ${normalized}`.trim();
      recentContext = recentContext.split(" ").slice(-20).join(" ");
    }

    if (!/^\d{1,2}(?:\.\d{2})?$/.test(line)) continue;

    const price = `$${line}`;
    const nextLine = lines[i + 1] || "";
    const nextNextLine = lines[i + 2] || "";

    if (!nextLine) continue;

    const candidateText = `${nextLine} ${nextNextLine}`.trim();
    const lineMatches =
      queryMatchesText(dishQuery, nextLine) ||
      queryMatchesText(dishQuery, candidateText) ||
      queryMatchesContext(dishQuery, candidateText, `${currentHeading} ${recentContext}`);
    const headingMatches = currentHeading ? queryMatchesText(dishQuery, currentHeading) : false;
    if (!lineMatches && !headingMatches) continue;

    const itemName = nextLine;
    const description = nextNextLine && !/^\d{1,2}(?:\.\d{2})?$/.test(nextNextLine) ? nextNextLine : "";

    if (!itemName || likelyCategoryLabel(itemName)) continue;
    if (
      queryIntent.dietaryTokens.length > 0 &&
      !isVegetarianCompatible(`${currentHeading} ${itemName} ${description}`)
    ) {
      continue;
    }

    const itemText = [itemName, description].filter(Boolean).join(" ");
    const key = `${normalize(itemName)}|${price}`;
    if (seen.has(key)) continue;
    seen.add(key);

    hits.push({
      itemName,
      description,
      itemText,
      price,
      sourceUrl,
      sourceType:
        sourceUrl.includes("toasttab.com")
          ? "toast_ordering"
          : sourceUrl.includes("spoton.com")
            ? "spoton_ordering"
            : "website_or_ordering_page",
    });
  }

  return hits;
}

function parseForwardPriceMenuHits(html: string, dishQuery: string, sourceUrl: string): MenuHit[] {
  const $ = cheerio.load(html);
  const queryIntent = parseQueryIntent(dishQuery);
  const lines = $("body")
    .text()
    .split("\n")
    .map((line) => cleanDisplayText(line))
    .filter((line) => line.length > 1 && line.length < 240);

  const hits: MenuHit[] = [];
  const seen = new Set<string>();
  let currentHeading = "";

  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    const normalized = normalize(line);

    if (likelyCategoryLabel(normalized)) {
      currentHeading = normalized;
      continue;
    }

    const nextLines = lines.slice(i + 1, i + 5);
    const priceLine = nextLines.find((candidate) => /^\$?\d{1,2}(?:\.\d{2})?$/.test(candidate));
    if (!priceLine) continue;

    const blockText = [line, ...nextLines].join(" ");
    const lineMatches =
      queryMatchesText(dishQuery, line) ||
      queryMatchesText(dishQuery, blockText) ||
      queryMatchesContext(dishQuery, blockText, currentHeading);
    if (!lineMatches) continue;

    const price = priceLine.startsWith("$") ? priceLine : `$${priceLine}`;
    const priceIndex = nextLines.indexOf(priceLine);
    const detailLines = nextLines.slice(0, priceIndex).filter((candidate) => !candidate.startsWith("$"));
    const description = detailLines.join(" ").trim();

    if (!line || likelyCategoryLabel(line)) continue;
    if (
      queryIntent.dietaryTokens.length > 0 &&
      !isVegetarianCompatible(`${currentHeading} ${line} ${description}`)
    ) {
      continue;
    }

    const key = `${normalize(line)}|${price}`;
    if (seen.has(key)) continue;
    seen.add(key);

    hits.push({
      itemName: line,
      description,
      itemText: `${line} ${description}`.trim(),
      price,
      sourceUrl,
      sourceType:
        sourceUrl.includes("toasttab.com")
          ? "toast_ordering"
          : sourceUrl.includes("spoton.com")
            ? "spoton_ordering"
            : "website_or_ordering_page",
    });
  }

  return hits;
}

function sortLinksByPriority(links: string[]) {
  const priority = (link: string) => {
    const lower = link.toLowerCase();
    if (lower.includes("toasttab.com")) return 0;
    if (lower.includes("spoton.com")) return 1;
    if (lower.includes("order")) return 2;
    if (lower.includes("menu")) return 3;
    return 4;
  };

  return [...links].sort((a, b) => priority(a) - priority(b));
}

function parseLittleChihuahuaMenu(html: string, dishQuery: string, sourceUrl: string): MenuHit[] {
  if (!sourceUrl.includes("thelittlechihuahua.com")) return [];

  const lines = html
    .split("\n")
    .map((line) => cleanDisplayText(line))
    .filter(Boolean);

  const hits: MenuHit[] = [];
  const seen = new Set<string>();
  let inBurritoSection = false;

  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    const normalized = normalize(line);

    if (normalized.includes("burrito or bowl")) {
      inBurritoSection = true;
      continue;
    }

    if (inBurritoSection && normalized.startsWith("### ")) {
      inBurritoSection = false;
    }

    if (!inBurritoSection) continue;
    if (!/^\d{1,2}(?:\.\d{2})?$/.test(line)) continue;

    const price = `$${line}`;
    const itemName = lines[i + 1] || "";
    const description = lines[i + 2] || "";
    const combined = `${itemName} ${description}`.trim();

    if (!itemName) continue;
    if (!queryMatchesContext(dishQuery, combined, "burrito vegetarian vegan veggie")) continue;

    const key = `${normalize(itemName)}|${price}`;
    if (seen.has(key)) continue;
    seen.add(key);

    hits.push({
      itemName,
      description,
      itemText: combined,
      price,
      sourceUrl,
      sourceType:
        sourceUrl.includes("toasttab.com")
          ? "toast_ordering"
          : sourceUrl.includes("spoton.com")
            ? "spoton_ordering"
            : "website_or_ordering_page",
    });
  }

  return hits;
}

function collectRelevantLinks(html: string, baseUrl: string, dishQuery: string): string[] {
  const $ = cheerio.load(html);
  const urls = new Set<string>();
  const queryKeywords = tokenize(dishQuery);

  const keywords = [
    "menu",
    "order",
    "ordering",
    "pickup",
    "delivery",
    "toast",
    "spoton",
    "slice",
    "doordash",
    "ubereats",
    "grubhub",
    "chownow",
    "clover",
    ...queryKeywords,
  ];

  $("a[href]").each((_, el) => {
    const href = ($(el).attr("href") || "").trim();
    const label = ($(el).text() || "").toLowerCase();
    const hrefLower = href.toLowerCase();
    if (!href) return;

    const isMatch = keywords.some((k) => hrefLower.includes(k) || label.includes(k));
    if (!isMatch) return;

    const full = absoluteUrl(baseUrl, href);
    if (full.startsWith("http")) urls.add(full);
  });

  const rawUrlMatches = html.match(
    /(?:https?:\/\/|\/)[^"'`\s<>]+(?:menu|order|ordering|pickup|delivery|category)[^"'`\s<>]*/gi
  );

  for (const match of rawUrlMatches || []) {
    const lower = match.toLowerCase();
    const isRelevant =
      keywords.some((keyword) => lower.includes(keyword)) ||
      queryKeywords.some((keyword) => lower.includes(keyword));

    if (!isRelevant) continue;

    const full = absoluteUrl(baseUrl, match);
    if (full.startsWith("http")) urls.add(full);
  }

  return Array.from(urls).slice(0, 15);
}

async function fetchText(url: string): Promise<string | null> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);

  try {
    const res = await fetch(url, {
      headers: { "User-Agent": "Mozilla/5.0 FoodFinder/1.0" },
      cache: "no-store",
      redirect: "follow",
      signal: controller.signal,
    });
    if (!res.ok) return null;
    return await res.text();
  } catch {
    return null;
  } finally {
    clearTimeout(timeout);
  }
}

async function findDishHitsForWebsite(websiteUrl: string, dish: string): Promise<MenuHit[]> {
  const cacheKey = `${CACHE_VERSION}:menuhits:${normalize(websiteUrl)}:${normalize(dish)}`;
  const cached = await getCachedValue<MenuHit[]>(cacheKey, CACHE_DAYS);
  if (cached) return cached.value;
  const staleCached = await getAnyCachedValue<MenuHit[]>(cacheKey);

  const homeHtml = await fetchText(websiteUrl);
  if (!homeHtml) return staleCached?.value || [];

  const allHits: MenuHit[] = [];
  const visitedLinks = new Set<string>();

  // Try homepage
  allHits.push(...extractMenuHitsFromHtml(homeHtml, dish, websiteUrl));
  allHits.push(...parseSequentialMenuHits(homeHtml, dish, websiteUrl));
  allHits.push(...parseForwardPriceMenuHits(homeHtml, dish, websiteUrl));
  allHits.push(...parseLittleChihuahuaMenu(homeHtml, dish, websiteUrl));

  // Try menu/order links (Toast/Slice/etc)
  const links = sortLinksByPriority(collectRelevantLinks(homeHtml, websiteUrl, dish));
  for (const link of links) {
    if (visitedLinks.has(link)) continue;
    visitedLinks.add(link);

    const html = await fetchText(link);
    if (!html) continue;
    allHits.push(...extractMenuHitsFromHtml(html, dish, link));
    allHits.push(...parseSequentialMenuHits(html, dish, link));
    allHits.push(...parseForwardPriceMenuHits(html, dish, link));
    allHits.push(...parseLittleChihuahuaMenu(html, dish, link));

    // One more level deep for category links like ?category=Vegetarian+Burritos
    const nestedLinks = sortLinksByPriority(collectRelevantLinks(html, link, dish));
    for (const nestedLink of nestedLinks) {
      if (visitedLinks.has(nestedLink)) continue;
      visitedLinks.add(nestedLink);

      const nestedHtml = await fetchText(nestedLink);
      if (!nestedHtml) continue;
      allHits.push(...extractMenuHitsFromHtml(nestedHtml, dish, nestedLink));
      allHits.push(...parseSequentialMenuHits(nestedHtml, dish, nestedLink));
      allHits.push(...parseForwardPriceMenuHits(nestedHtml, dish, nestedLink));
      allHits.push(...parseLittleChihuahuaMenu(nestedHtml, dish, nestedLink));
    }
  }

  // Deduplicate
  const dedup = new Map<string, MenuHit>();
  for (const h of allHits) {
    const k = `${normalize(h.itemName)}|${h.price}`;
    if (!dedup.has(k)) dedup.set(k, h);
  }

  const finalHits = Array.from(dedup.values()).slice(0, 20);
  if (finalHits.length > 0) {
    await setCachedValue(cacheKey, finalHits);
    return finalHits;
  }

  return staleCached?.value || [];
}

async function geocodeAddress(address: string, apiKey: string) {
  const cacheKey = `${CACHE_VERSION}:geocode:${normalize(address)}`;
  const cached = await getCachedValue<{ lat: number; lng: number }>(cacheKey, CACHE_DAYS);
  if (cached) return cached.value;

  const url = new URL("https://maps.googleapis.com/maps/api/geocode/json");
  url.searchParams.set("address", address);
  url.searchParams.set("key", apiKey);

  const res = await fetch(url, { cache: "no-store" });
  const json = await res.json();

  if (!res.ok || json.status !== "OK" || !json.results?.[0]?.geometry?.location) {
    throw new Error("Could not understand that address");
  }

  const location = json.results[0].geometry.location as { lat: number; lng: number };
  await setCachedValue(cacheKey, location);
  return location;
}

function distanceMiles(
  startLat: number,
  startLng: number,
  endLat?: number,
  endLng?: number
) {
  if (
    typeof endLat !== "number" ||
    typeof endLng !== "number" ||
    Number.isNaN(endLat) ||
    Number.isNaN(endLng)
  ) {
    return undefined;
  }

  const toRad = (value: number) => (value * Math.PI) / 180;
  const earthRadiusMiles = 3958.8;
  const dLat = toRad(endLat - startLat);
  const dLng = toRad(endLng - startLng);
  const a =
    Math.sin(dLat / 2) * Math.sin(dLat / 2) +
    Math.cos(toRad(startLat)) *
      Math.cos(toRad(endLat)) *
      Math.sin(dLng / 2) *
      Math.sin(dLng / 2);
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  return Math.round(earthRadiusMiles * c * 10) / 10;
}

function numericPrice(price: string) {
  const parsed = Number(price.replace(/[^0-9.]/g, ""));
  return Number.isFinite(parsed) ? parsed : Number.POSITIVE_INFINITY;
}

function withinRadius(distance: number | undefined, radiusMiles: number) {
  if (typeof distance !== "number" || Number.isNaN(distance)) return false;
  return distance <= radiusMiles;
}

async function chunkedMap<T, R>(
  items: T[],
  batchSize: number,
  worker: (item: T) => Promise<R>
) {
  const results: R[] = [];

  for (let i = 0; i < items.length; i += batchSize) {
    const batch = items.slice(i, i + batchSize);
    const batchResults = await Promise.all(batch.map((item) => worker(item)));
    results.push(...batchResults);
  }

  return results;
}

function dedupePlaces(places: Place[]) {
  const deduped = new Map<string, Place>();

  for (const place of places) {
    const key = `${normalize(place.displayName?.text || "")}|${normalize(place.formattedAddress || "")}`;
    if (!key.replace(/\|/g, "").trim()) continue;
    if (!deduped.has(key)) deduped.set(key, place);
  }

  return Array.from(deduped.values());
}

export async function POST(req: NextRequest) {
  try {
    const { dish, address, radiusMiles } = await req.json();

    if (!dish || !address) {
      return NextResponse.json({ error: "Dish and address are required" }, { status: 400 });
    }

    const apiKey = process.env.GOOGLE_MAPS_API_KEY;
    if (!apiKey) {
      return NextResponse.json({ error: "Missing GOOGLE_MAPS_API_KEY" }, { status: 500 });
    }

    const searchCacheKey = `${CACHE_VERSION}:search:${normalize(dish)}:${normalize(address)}:${radiusMiles || "1"}`;
    const cachedSearch = await getCachedValue<SearchResponsePayload>(searchCacheKey, CACHE_DAYS);
    if (cachedSearch) {
      return NextResponse.json({
        ...cachedSearch.value,
        note: `${cachedSearch.value.note} Served from 30-day cache.`,
      });
    }

    const meters = Math.round((Number(radiusMiles || 1) * 1609.34));
    const center = await geocodeAddress(address, apiKey);
    const placesCacheKey = `${CACHE_VERSION}:places:${normalize(address)}:${meters}`;
    const cachedPlaces = await getCachedValue<Place[]>(placesCacheKey, CACHE_DAYS);
    let places: Place[];

    if (cachedPlaces) {
      places = cachedPlaces.value;
    } else {
      const fieldMask =
        "places.displayName,places.formattedAddress,places.rating,places.currentOpeningHours.openNow,places.websiteUri,places.googleMapsUri,places.location";

      const nearbyRes = await fetch("https://places.googleapis.com/v1/places:searchNearby", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Goog-Api-Key": apiKey,
          "X-Goog-FieldMask": fieldMask,
        },
        body: JSON.stringify({
          includedTypes: ["restaurant", "meal_takeaway", "meal_delivery"],
          maxResultCount: 20,
          rankPreference: "DISTANCE",
          locationRestriction: {
            circle: {
              center: { latitude: center.lat, longitude: center.lng },
              radius: meters,
            },
          },
        }),
      });

      const nearbyJson = await nearbyRes.json();
      if (!nearbyRes.ok) {
        return NextResponse.json(
          { error: nearbyJson?.error?.message || "Google Places request failed" },
          { status: 500 }
        );
      }

      const textRes = await fetch("https://places.googleapis.com/v1/places:searchText", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Goog-Api-Key": apiKey,
          "X-Goog-FieldMask": fieldMask,
        },
        body: JSON.stringify({
          textQuery: `restaurants near ${address}`,
          pageSize: 20,
          locationBias: {
            circle: {
              center: { latitude: center.lat, longitude: center.lng },
              radius: meters,
            },
          },
        }),
      });

      const textJson = await textRes.json();
      const textPlaces = textRes.ok ? textJson.places || [] : [];

      const dishTextRes = await fetch("https://places.googleapis.com/v1/places:searchText", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Goog-Api-Key": apiKey,
          "X-Goog-FieldMask": fieldMask,
        },
        body: JSON.stringify({
          textQuery: `${dish} near ${address}`,
          pageSize: 20,
          locationBias: {
            circle: {
              center: { latitude: center.lat, longitude: center.lng },
              radius: meters,
            },
          },
        }),
      });

      const dishTextJson = await dishTextRes.json();
      const dishTextPlaces = dishTextRes.ok ? dishTextJson.places || [] : [];

      places = dedupePlaces([...dishTextPlaces, ...(nearbyJson.places || []), ...textPlaces]);
      await setCachedValue(placesCacheKey, places);
    }

    const crawlablePlaces = places.filter((p) => p.websiteUri).slice(0, MAX_CANDIDATE_RESTAURANTS);
    const placeResults = await chunkedMap(crawlablePlaces, SITE_CHECK_BATCH_SIZE, async (p) => {
      const website = p.websiteUri as string | undefined;
      if (!website) return [] as SearchResult[];

      const hits = await findDishHitsForWebsite(website, dish);
      if (hits.length === 0) return [] as SearchResult[];

      return hits.map((hit) => ({
          restaurantName: p.displayName?.text || "Unknown",
          address: p.formattedAddress || "",
          rating: p.rating,
          openNow: p.currentOpeningHours?.openNow,
          dish,
          itemName: hit.itemName,
          price: hit.price,
          description: hit.description,
          sourceType: hit.sourceType || "website_or_ordering_page",
          sourceUrl: hit.sourceUrl,
          websiteUrl: website,
          googleMapsUrl: p.googleMapsUri || null,
          distanceMiles: distanceMiles(
            center.lat,
            center.lng,
            p.location?.latitude,
            p.location?.longitude
          ),
        }));
    });

    const results: SearchResult[] = placeResults.flat();

    const requestedRadiusMiles = Number(radiusMiles || 1);
    const filteredResults = results.filter(
      (result) =>
        shouldKeepResultForQuery(result, dish) &&
        withinRadius(result.distanceMiles, requestedRadiusMiles)
    );

    const dedupedResults = new Map<string, SearchResult>();
    for (const result of filteredResults) {
      const key = `${normalize(result.address)}|${normalize(result.itemName)}|${result.price}`;
      const existing = dedupedResults.get(key);
      if (!existing || (result.rating ?? 0) > (existing.rating ?? 0)) {
        dedupedResults.set(key, result);
      }
    }

    const responsePayload: SearchResponsePayload = {
      results: Array.from(dedupedResults.values())
        .sort((a, b) => {
          const priceDifference = numericPrice(a.price) - numericPrice(b.price);
          if (priceDifference !== 0) return priceDifference;

          const aDistance = a.distanceMiles ?? Number.POSITIVE_INFINITY;
          const bDistance = b.distanceMiles ?? Number.POSITIVE_INFINITY;
          return aDistance - bDistance;
        })
        .slice(0, 100),
      note:
        "Results come from restaurant websites or ordering pages. Section matches like Burritos or Burgers can now return the priced items listed underneath.",
    };

    await setCachedValue(searchCacheKey, responsePayload);

    return NextResponse.json(responsePayload);
  } catch (e: unknown) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : "Unexpected error" },
      { status: 500 }
    );
  }
}
