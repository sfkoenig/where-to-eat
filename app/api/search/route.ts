import { NextRequest, NextResponse } from "next/server";
import * as cheerio from "cheerio";
import { getAnyCachedValue, getCachedValue, setCachedValue } from "@/lib/server-cache";
import { MANUAL_RESTAURANT_OVERRIDES } from "@/lib/manual-overrides";

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
  id?: string;
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
  diagnostics?: {
    totalPlaces: number;
    enrichedPlaces: number;
    crawlablePlaces: number;
    checkedPlaces: number;
    lines: string[];
  };
};

type PlaceCollectionResult = {
  results: SearchResult[];
  diagnostics: string[];
};

type KnownRestaurantFallback = {
  restaurantName: string;
  address: string;
  lat: number;
  lng: number;
  websiteUrl: string;
  googleMapsUrl?: string | null;
  sourceUrls: string[];
  cuisines: string[];
};

type ManualOverrideResult = {
  results: SearchResult[];
  diagnostics: string[];
};

const CACHE_DAYS = 30;
const CACHE_VERSION = "v54";
const FETCH_TIMEOUT_MS = 5000;
const ORDERING_FETCH_TIMEOUT_MS = 9000;
const SITE_CHECK_BATCH_SIZE = 4;
const MAX_CANDIDATE_RESTAURANTS = 12;
const SEARCH_TIME_BUDGET_MS = 15000;
const MAX_LINKS_PER_SITE = 5;
const MAX_NESTED_LINKS_PER_SITE = 2;

const KNOWN_RESTAURANT_FALLBACKS: KnownRestaurantFallback[] = [
  {
    restaurantName: "Khob Khun Thai Cuisine & Breakfast",
    address: "3741 Geary Blvd, San Francisco, CA 94118, USA",
    lat: 37.780547,
    lng: -122.45949,
    websiteUrl: "https://www.khobkhunsf.com/thaimenu",
    googleMapsUrl: null,
    sourceUrls: [
      "https://www.khobkhunsf.com/thaimenu",
      "https://order.toasttab.com/online/khob-khun-thai-cuisine-breakfast-3741-geary-blvd",
    ],
    cuisines: ["thai"],
  },
];

function absoluteUrl(base: string, href: string) {
  try {
    return new URL(href, base).toString();
  } catch {
    return "";
  }
}

function normalize(s: string) {
  return s
    .replace(/[’‘]/g, "'")
    .replace(/([a-z])([A-Z])/g, "$1 $2")
    .replace(/&/g, " ")
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim();
}

const TOKEN_ALIASES: Record<string, string[]> = {
  tso: ["tsao"],
  tsao: ["tso"],
};

function tokenize(s: string) {
  return normalize(s)
    .replace(/\b([a-z0-9]+)'s\b/g, "$1")
    .replace(/[^a-z0-9\s]/g, " ")
    .split(" ")
    .map((part) => part.trim())
    .filter((part) => Boolean(part) && part !== "s");
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
  "sofritas",
  "falafel",
  "eggplant",
  "cauliflower",
  "spinach",
]);
const CONTEXTUAL_LEADING_TOKENS = new Set([
  "american",
  "cajun",
  "chinese",
  "french",
  "greek",
  "indian",
  "italian",
  "japanese",
  "korean",
  "mexican",
  "spicy",
  "thai",
  "vietnamese",
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
  "impossible dog",
  "beyond dog",
  "vegan sausage",
  "veggie sausage",
  "vegetarian sausage",
  "veg dog",
  "vegan dog",
  "veggie dog",
  "vegetarian dog",
  "sub veg dog",
  "sub vegan dog",
  "sub veggie dog",
  "substitute veg dog",
  "substitute vegan dog",
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
  const normalizedQuery = tokenize(query)
    .map((token) => singularize(token))
    .filter((token, index, tokens) => !(token === "hot" && tokens[index + 1] === "dog"));

  return {
    coreTokens: normalizedQuery.filter((token) => !DIETARY_TERMS.has(token)),
    dietaryTokens: normalizedQuery.filter((token) => DIETARY_TERMS.has(token)),
  };
}

function inferCuisineKeyword(query: string) {
  const forms = buildTokenForms(query);

  if (
    ["pad", "thai", "tom", "yum", "panang", "khao", "soi", "larb", "satay", "ew", "mao"].some(
      (token) => forms.has(token)
    )
  ) {
    return "thai";
  }

  if (
    [
      "general",
      "tso",
      "tsao",
      "kung",
      "pao",
      "mapo",
      "lo",
      "mein",
      "chow",
      "fried",
      "rice",
      "wonton",
      "dumpling",
      "szechuan",
      "schezwan",
    ].some((token) => forms.has(token))
  ) {
    return "chinese";
  }

  if (
    ["burrito", "taco", "taqueria", "quesadilla", "enchilada", "tamale"].some((token) =>
      forms.has(token)
    )
  ) {
    return "mexican";
  }

  if (["pancake", "waffle", "omelet", "omelette", "breakfast"].some((token) => forms.has(token))) {
    return "breakfast";
  }

  return "";
}

function isRestaurantRelevantToQuery(
  restaurantName: string,
  query: string,
  cuisines: string[] = [],
  sourceNote = ""
) {
  const cuisineKeyword = inferCuisineKeyword(query);
  if (cuisineKeyword && cuisines.length > 0 && !cuisines.includes(cuisineKeyword)) return false;

  const text = `${restaurantName} ${sourceNote}`;
  if (queryMatchesText(query, text)) return true;
  if (cuisineKeyword && normalize(text).includes(cuisineKeyword)) return true;

  return cuisines.length === 0;
}

function buildTokenForms(text: string) {
  const forms = new Set<string>();
  for (const token of tokenize(text)) {
    forms.add(token);
    forms.add(singularize(token));
    for (const alias of TOKEN_ALIASES[token] || []) {
      forms.add(alias);
      forms.add(singularize(alias));
    }
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

function isDogLikeQuery(query: string) {
  const { coreTokens } = parseQueryIntent(query);
  return coreTokens.some((token) => token === "dog" || token === "sausage");
}

function hasDogLikeAnchor(text: string) {
  const normalized = ` ${normalize(text)} `;
  return (
    normalized.includes(" dog ") ||
    normalized.includes(" hot dog ") ||
    normalized.includes(" hotdog ") ||
    normalized.includes(" sausage ")
  );
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

  if (isDogLikeQuery(query)) {
    const visibleHasDogAnchor = hasDogLikeAnchor(visibleText) || hasDogLikeAnchor(result.itemName);
    if (!visibleHasDogAnchor) return false;

    const explicitVegSignalVisible =
      isVegetarianCompatible(visibleText) ||
      FLEXIBLE_PROTEIN_PHRASES.some((phrase) => normalized.includes(` ${phrase} `));

    if (!explicitVegSignalVisible) return false;
  }

  return isVegetarianCompatible(combinedText);
}

function isLowConfidenceResult(result: SearchResult, query: string) {
  const normalizedItem = normalize(result.itemName);
  const normalizedQuery = normalize(query);
  const hasDescription =
    Boolean(result.description) && result.description !== "No description available.";

  if (
    !hasDescription &&
    normalizedItem === normalizedQuery &&
    !result.sourceUrl.includes("toasttab.com") &&
    !result.sourceUrl.includes("spoton.com")
  ) {
    return true;
  }

  if (
    !hasDescription &&
    normalizedItem === normalizedQuery &&
    result.sourceUrl.includes("toast.site/order")
  ) {
    return true;
  }

  return false;
}

function isPriceOnlyText(text: string) {
  return /^\$?\d{1,3}(?:\.\d{2})?$/.test(text.trim());
}

function looksLikeModifierPriceContext(text: string) {
  const normalized = normalize(text);
  return (
    normalized.includes("add $") ||
    normalized.includes("extra $") ||
    normalized.includes("upgrade $") ||
    normalized.includes("for beef") ||
    normalized.includes("for chicken") ||
    normalized.includes("for pork") ||
    normalized.includes("for shrimp") ||
    normalized.includes("for tofu") ||
    normalized.includes("substitute") ||
    normalized.includes("additional charge")
  );
}

function parsePriceValue(text: string) {
  const numeric = Number(text.replace(/[^0-9.]/g, ""));
  return Number.isFinite(numeric) ? numeric : Number.NaN;
}

function chooseBestPriceLine(lines: string[]) {
  const candidates = lines
    .filter((line) => /^\$?\d{1,2}(?:\.\d{2})?$/.test(line))
    .map((line) => ({ line, value: parsePriceValue(line) }))
    .filter(({ line, value }) => Number.isFinite(value) && !looksLikeModifierPriceContext(line));

  if (candidates.length === 0) return null;

  const entreeCandidate = candidates.find(({ value }) => value >= 5);
  if (entreeCandidate) return entreeCandidate.line;

  return candidates[candidates.length - 1].line;
}

function resultMatchesQueryStrictly(result: SearchResult, query: string) {
  const visibleText = [result.itemName, result.description].filter(Boolean).join(" ").trim();
  if (!visibleText) return false;
  if (isPriceOnlyText(result.itemName)) return false;
  if (looksLikeGenericItemName(result.itemName)) return false;

  return queryMatchesContext(query, visibleText, "");
}

function queryMatchesText(query: string, text: string) {
  const textForms = buildTokenForms(text);
  if (textForms.size === 0) return false;

  const { coreTokens, dietaryTokens } = parseQueryIntent(query);

  const hasCoreMatch =
    coreTokens.length === 0 ||
    coreTokens.every((token) => textForms.has(token)) ||
    supportsContextualCoreDrop(coreTokens, textForms, new Set<string>());
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
    coreTokens.every((token) => primaryForms.has(token) || contextForms.has(token)) ||
    supportsContextualCoreDrop(coreTokens, primaryForms, contextForms);
  if (!hasCoreMatch) return false;

  if (dietaryTokens.length === 0) return true;

  return dietaryTokens.every((token) => {
    if (token === "vegetarian" || token === "veggie" || token === "vegan") {
      return isVegetarianCompatible(`${primaryText} ${contextText}`);
    }
    return primaryForms.has(token) || contextForms.has(token);
  });
}

function coreHeadToken(query: string) {
  const { coreTokens } = parseQueryIntent(query);
  return coreTokens[coreTokens.length - 1] || "";
}

function supportsContextualCoreDrop(
  coreTokens: string[],
  primaryForms: Set<string>,
  contextForms: Set<string>
) {
  if (coreTokens.length < 3) return false;

  const [leadingToken, ...remainingTokens] = coreTokens;
  if (!leadingToken || remainingTokens.length === 0) return false;
  if (!CONTEXTUAL_LEADING_TOKENS.has(leadingToken)) return false;
  if (MEAT_TERMS.has(leadingToken)) return false;
  if (DIETARY_TERMS.has(leadingToken)) return false;
  if (!contextForms.has(leadingToken)) return false;

  return remainingTokens.every((token) => primaryForms.has(token) || contextForms.has(token));
}

function textHasHeadToken(text: string, query: string) {
  const headToken = coreHeadToken(query);
  if (!headToken) return true;
  return buildTokenForms(text).has(headToken);
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

function isSeparatorLine(line: string) {
  const normalized = cleanDisplayText(line);
  return /^([*•·-]\s*){2,}$/.test(normalized) || normalized === "* * *";
}

function looksLikeOptionLine(line: string) {
  const normalized = normalize(line);
  return (
    /^(small|large|medium)$/.test(normalized) ||
    /^(beef|chicken|pork|shrimp|tofu|veggies|vegetables)$/.test(normalized) ||
    normalized.includes("add $") ||
    normalized.includes("extra $") ||
    normalized.includes("choice of") ||
    normalized.includes("served with rice") ||
    normalized.includes("served with noodle")
  );
}

function selectDescriptionLines(lines: string[]) {
  return lines
    .filter(
      (line) =>
        line &&
        !isPriceOnlyText(line) &&
        !isSeparatorLine(line) &&
        !looksLikeGarbageText(line) &&
        !looksLikeGenericItemName(line) &&
        !looksLikeOptionLine(line)
    )
    .slice(0, 2)
    .join(" ")
    .trim();
}

function selectDescriptionAroundPrice(lines: string[], priceIndex: number) {
  const before = lines.slice(Math.max(0, priceIndex - 3), priceIndex);
  const after = lines.slice(priceIndex + 1, priceIndex + 4);
  const preferred = selectDescriptionLines([...before, ...after]);
  if (preferred) return preferred;
  return selectDescriptionLines(lines);
}

function parseLocalBlockMenuHits(html: string, dishQuery: string, sourceUrl: string): MenuHit[] {
  const $ = cheerio.load(html);
  const hits: MenuHit[] = [];
  const seen = new Set<string>();

  $("article, section, li, div").each((_, el) => {
    const blockLines = $(el)
      .find("h1, h2, h3, h4, h5, h6, p, span, div, li, td")
      .map((__, child) => cleanDisplayText($(child).text()))
      .get()
      .filter((line) => line.length > 1 && line.length < 220 && !isSeparatorLine(line));

    if (blockLines.length < 2) return;

    const candidateItem = blockLines.find(
      (line) =>
        !isPriceOnlyText(line) &&
        !looksLikeGarbageText(line) &&
        !looksLikeGenericItemName(line) &&
        !looksLikeOptionLine(line) &&
        queryMatchesText(dishQuery, line)
    );
    if (!candidateItem) return;

    const priceLine = chooseBestPriceLine(blockLines);
    if (!priceLine) return;

    const priceIndex = blockLines.indexOf(priceLine);
    const itemIndex = blockLines.indexOf(candidateItem);
    if (itemIndex === -1 || priceIndex === -1) return;
    if (Math.abs(priceIndex - itemIndex) > 6) return;

    const description = selectDescriptionAroundPrice(blockLines, priceIndex);
    const price = priceLine.startsWith("$") ? priceLine : `$${priceLine}`;
    const key = `${normalize(candidateItem)}|${price}`;
    if (seen.has(key)) return;
    seen.add(key);

    hits.push({
      itemName: candidateItem,
      description: description === candidateItem ? "" : description,
      itemText: [candidateItem, description].filter(Boolean).join(" "),
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

function parseStructuredVariantMenuHits(html: string, dishQuery: string, sourceUrl: string): MenuHit[] {
  const $ = cheerio.load(html);
  const hits: MenuHit[] = [];
  const seen = new Set<string>();

  $('[data-hook="item.description"]').each((_, el) => {
    const description = cleanDisplayText($(el).text());
    const titleText = cleanDisplayText($(el).prevAll().first().text());
    const variants = $(el).nextAll('[data-hook="item.priceVariants"]').first();

    if (!titleText || !variants.length) return;
    if (!queryMatchesContext(dishQuery, titleText, description)) return;
    if (looksLikeGarbageText(titleText) || looksLikeGenericItemName(titleText)) return;

    variants.find('[data-hook="item.variant"]').each((__, variantEl) => {
      const variantName = cleanDisplayText($(variantEl).find('[data-hook="variant.name"]').first().text());
      const variantPrice = cleanDisplayText($(variantEl).find('[data-hook="variant.price"]').first().text());
      if (!variantPrice || !/^\$?\d{1,3}(?:\.\d{2})?$/.test(variantPrice)) return;

      const itemName = variantName ? `${titleText} (${variantName})` : titleText;
      const price = variantPrice.startsWith("$") ? variantPrice : `$${variantPrice}`;
      const key = `${normalize(itemName)}|${price}`;
      if (seen.has(key)) return;
      seen.add(key);

      hits.push({
        itemName,
        description,
        itemText: [itemName, description].filter(Boolean).join(" "),
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
  });

  return hits;
}

function parseWixRichTextMenuHits(html: string, dishQuery: string, sourceUrl: string): MenuHit[] {
  const $ = cheerio.load(html);
  const hits: MenuHit[] = [];
  const seen = new Set<string>();

  $("h1, h2, h3, h4, h5").each((_, el) => {
    const titleText = cleanDisplayText($(el).text());
    if (!titleText) return;
    if (looksLikeGarbageText(titleText) || looksLikeGenericItemName(titleText)) return;

    const priceMatch = titleText.match(/\$\s?\d{1,3}(?:\.\d{2})?/);
    const itemName = cleanDisplayText(titleText.replace(/\$\s?\d{1,3}(?:\.\d{2})?/g, " "));
    if (!itemName) return;

    let price = priceMatch?.[0]?.replace(/\s+/g, "");
    if (!price) {
      const nearbyPrice = cleanDisplayText($(el).find("span").last().text());
      if (/^\$?\d{1,3}(?:\.\d{2})?$/.test(nearbyPrice)) {
        price = nearbyPrice.startsWith("$") ? nearbyPrice : `$${nearbyPrice}`;
      }
    }
    if (!price) return;

    const descriptionParts: string[] = [];
    $(el)
      .nextAll("h6")
      .slice(0, 3)
      .each((__, sibling) => {
        const text = cleanDisplayText($(sibling).text());
        if (
          text &&
          !isPriceOnlyText(text) &&
          !looksLikeGarbageText(text) &&
          !looksLikeGenericItemName(text) &&
          !looksLikeMetadataText(text)
        ) {
          descriptionParts.push(text);
        }
      });

    const description = descriptionParts.join(" ").trim();
    if (!queryMatchesContext(dishQuery, itemName, description)) return;
    const key = `${normalize(itemName)}|${price}`;
    if (seen.has(key)) return;
    seen.add(key);

    hits.push({
      itemName,
      description,
      itemText: [itemName, description].filter(Boolean).join(" "),
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

function parseEnumeratedMenuHits(html: string, dishQuery: string, sourceUrl: string): MenuHit[] {
  const lines = cheerio
    .load(html)("body")
    .text()
    .split("\n")
    .map((line) => cleanDisplayText(line))
    .filter(Boolean);

  const hits: MenuHit[] = [];
  const seen = new Set<string>();

  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    const headingMatch = line.match(/^\d+\.\s+(.+)$/);
    const itemName = cleanDisplayText(headingMatch ? headingMatch[1] : line.replace(/^#+\s*\d+\.\s+/, ""));

    if (!itemName) continue;
    if (looksLikeGarbageText(itemName) || looksLikeGenericItemName(itemName)) continue;

    const nextLines = lines.slice(i + 1, i + 6);
    const priceLine = nextLines.find((candidate) => /^\$?\d{1,3}(?:\.\d{2})?$/.test(candidate));
    if (!priceLine) continue;

    const description = nextLines
      .filter((candidate) => candidate !== priceLine)
      .filter(
        (candidate) =>
          !isPriceOnlyText(candidate) &&
          !looksLikeGarbageText(candidate) &&
          !looksLikeGenericItemName(candidate) &&
          !looksLikeMetadataText(candidate)
      )
      .join(" ")
      .trim();
    if (!queryMatchesContext(dishQuery, itemName, description)) continue;

    const price = priceLine.startsWith("$") ? priceLine : `$${priceLine}`;
    const key = `${normalize(itemName)}|${price}`;
    if (seen.has(key)) continue;
    seen.add(key);

    hits.push({
      itemName,
      description,
      itemText: [itemName, description].filter(Boolean).join(" "),
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

function cleanDisplayText(text: string) {
  return text
    .replace(/([a-z])([A-Z])/g, "$1 $2")
    .replace(/[“”]/g, '"')
    .replace(/\s+/g, " ")
    .trim();
}

function looksLikeGarbageText(text: string) {
  const normalized = normalize(text);
  return (
    normalized.startsWith("#block-") ||
    normalized.includes("sqs-block") ||
    normalized.includes("--") ||
    normalized.includes("{") ||
    normalized.includes("}") ||
    /yui[_-]\d/i.test(text)
  );
}

function looksLikeGenericItemName(text: string) {
  const normalized = normalize(text);
  return (
    normalized === "order online" ||
    normalized === "menu" ||
    normalized === "online ordering" ||
    normalized === "start order" ||
    normalized === "pickup" ||
    normalized === "delivery"
  );
}

function looksLikeMetadataText(text: string) {
  const normalized = normalize(text);
  return (
    normalized.includes(" photos ") ||
    normalized.includes(" reviews ") ||
    /^\d+\s+photos\b/.test(normalized) ||
    /^\d+\s+reviews\b/.test(normalized) ||
    normalized.includes(" photo ") ||
    normalized.includes(" review ")
  );
}

function normalizedFingerprint(text: string) {
  return tokenize(text).slice(0, 16).join(" ");
}

function resultQualityScore(result: SearchResult) {
  let score = 0;
  if (!looksLikeGarbageText(result.itemName) && !looksLikeGenericItemName(result.itemName)) score += 10;
  if (result.description && !looksLikeGarbageText(result.description)) score += 6;
  if (result.itemName.split(" ").length <= 6) score += 4;
  if (result.itemName.length > 0 && result.itemName.length <= 50) score += 3;
  if (result.description && result.description !== "No description available.") score += 2;
  return score;
}

function resultsLookLikeSameDish(a: SearchResult, b: SearchResult) {
  if (normalize(a.address) !== normalize(b.address)) return false;
  if (a.price !== b.price) return false;

  const aTitle = normalizedFingerprint(a.itemName);
  const bTitle = normalizedFingerprint(b.itemName);
  const aDescription = normalizedFingerprint(a.description || "");
  const bDescription = normalizedFingerprint(b.description || "");

  if (aTitle && bTitle && aTitle === bTitle) return true;
  if (aTitle && bDescription && aTitle === bDescription) return true;
  if (bTitle && aDescription && bTitle === aDescription) return true;

  return false;
}

function deriveDescriptionFromItemText(itemName: string, itemText: string) {
  const cleanedItemName = cleanDisplayText(itemName);
  const cleanedItemText = cleanDisplayText(itemText);

  if (!cleanedItemText || cleanedItemText === cleanedItemName) return "";
  if (isPriceOnlyText(cleanedItemText)) return "";

  const normalizedItemName = normalize(cleanedItemName);
  const normalizedItemText = normalize(cleanedItemText);

  if (normalizedItemText.startsWith(normalizedItemName)) {
    const suffix = cleanedItemText.slice(cleanedItemName.length).replace(/^[\s,:.-]+/, "").trim();
    const collapsedSuffix = suffix.replace(
      new RegExp(`^(?:${cleanedItemName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s*)+`, "i"),
      ""
    ).trim();
    if (
      collapsedSuffix &&
      !isPriceOnlyText(collapsedSuffix) &&
      !looksLikeGarbageText(collapsedSuffix) &&
      !looksLikeGenericItemName(collapsedSuffix) &&
      !looksLikeMetadataText(collapsedSuffix) &&
      normalize(collapsedSuffix) !== normalizedItemName
    ) {
      return collapsedSuffix;
    }
  }

  return "";
}

function finalizedDescription(hit: MenuHit) {
  const explicit = cleanDisplayText(hit.description || "");
  if (
    explicit &&
    !isPriceOnlyText(explicit) &&
    !looksLikeGarbageText(explicit) &&
    !looksLikeGenericItemName(explicit) &&
    !looksLikeMetadataText(explicit) &&
    normalize(explicit) !== normalize(hit.itemName)
  ) {
    return explicit;
  }

  return deriveDescriptionFromItemText(hit.itemName, hit.itemText);
}

function canonicalItemKey(itemName: string) {
  return normalize(itemName)
    .replace(/\$\s?\d{1,3}(?:\.\d{2})?/g, " ")
    .replace(/\bimage\b/g, " ")
    .replace(/\b(photos?|reviews?)\b.*$/g, " ")
    .replace(/^(l|d)\s+/, "")
    .replace(/^(lunch|dinner)\s+/, "")
    .replace(/\s+/g, " ")
    .trim();
}

function mergeResultDetails(base: SearchResult, candidate: SearchResult) {
  const merged = { ...base };

  const baseHasDescription =
    Boolean(base.description) && base.description !== "No description available.";
  const candidateHasDescription =
    Boolean(candidate.description) && candidate.description !== "No description available.";

  if (!baseHasDescription && candidateHasDescription) {
    merged.description = candidate.description;
  }

  if (canonicalItemKey(candidate.itemName).length < canonicalItemKey(merged.itemName).length) {
    merged.itemName = candidate.itemName;
  }

  return merged;
}

function deriveItemNameAndDescription(raw: string, dishQuery: string, currentHeading: string) {
  const cleaned = cleanDisplayText(raw)
    .replace(/\s*\$\s?\d{1,3}(?:\.\d{2})?\s*/g, " ")
    .replace(/[“”]/g, '"')
    .trim();
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

  const quoteIndex = cleaned.indexOf('"');
  if (quoteIndex > 0) {
    itemName = cleaned.slice(0, quoteIndex).trim();
    description = cleaned
      .slice(quoteIndex + 1)
      .replace(/^["\s,:.-]+/, "")
      .replace(/["]+/g, " ")
      .trim();
  }

  if (!description && splitIndex > 0 && splitIndex < cleaned.length) {
    itemName = cleaned.slice(0, splitIndex).trim();
    description = cleaned.slice(splitIndex).replace(/^[\s,:.-]+/, "").trim();
  }

  if (!description) {
    const repeatedTail = new RegExp(`^(${itemName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")})(?:\\s+\\1)+$`, "i");
    if (repeatedTail.test(cleaned)) {
      itemName = cleaned.slice(0, itemName.length).trim();
      description = "";
    }
  }

  if (!itemName || itemName.startsWith("$")) {
    itemName = "";
  }

  itemName = itemName.replace(/["]+/g, "").trim();
  description = description.replace(/["]+/g, "").trim();

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
    if (isSeparatorLine(raw)) return;

    const tag = el.tagName?.toLowerCase() || "";
    const normalized = normalize(raw);

    if (tag.startsWith("h")) {
      currentHeading = normalized;
      return;
    }

    const priceMatches = raw.match(/\$\s?\d{1,3}(?:\.\d{2})?/g);
    if (!priceMatches || priceMatches.length !== 1) return;
    if (looksLikeModifierPriceContext(raw)) return;
    if (likelyCategoryLabel(normalized)) return;

    const { itemName, description, cleaned } = deriveItemNameAndDescription(raw, dishQuery, currentHeading);
    if (!itemName) return;
    if (looksLikeGarbageText(itemName) || looksLikeGarbageText(description) || looksLikeGarbageText(cleaned)) {
      return;
    }
    if (likelyCategoryLabel(itemName)) return;

    const itemMatches = queryMatchesText(dishQuery, itemName);
    const headingMatches = currentHeading ? queryMatchesText(dishQuery, currentHeading) : false;
    const sectionSupportedMatch =
      headingMatches &&
      textHasHeadToken(itemName, dishQuery) &&
      queryMatchesContext(dishQuery, itemName, `${description} ${currentHeading}`);

    if (!itemMatches && !sectionSupportedMatch) return;

    if (
      queryIntent.dietaryTokens.length > 0 &&
      !isVegetarianCompatible(`${currentHeading} ${itemName} ${description} ${cleaned}`)
    ) {
      return;
    }

    const price = priceMatches[0].replace(/\s+/g, "");
    const itemText = sectionSupportedMatch && !itemMatches ? `${cleaned} (${currentHeading})` : cleaned;
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

    if (isSeparatorLine(line)) continue;

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
    if (looksLikeGarbageText(itemName) || looksLikeGarbageText(description)) continue;
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

    if (isPriceOnlyText(line)) continue;
    if (looksLikeGarbageText(line) || looksLikeGenericItemName(line)) continue;

    const nextLines = lines
      .slice(i + 1, i + 9)
      .filter((candidate) => !isSeparatorLine(candidate));
    const priceLine = chooseBestPriceLine(nextLines);
    if (!priceLine) continue;

    const price = priceLine.startsWith("$") ? priceLine : `$${priceLine}`;
    const priceIndex = nextLines.indexOf(priceLine);
    const detailLines = nextLines
      .slice(0, priceIndex)
      .filter(
        (candidate) =>
          !candidate.startsWith("$") &&
          !/^(small|large|tofu\s*\/\s*veggies|chicken or pork|beef|shrimp)$/i.test(candidate)
      );
    const description = detailLines.join(" ").trim();
    const relevantBlock = [line, description].filter(Boolean).join(" ").trim();

    const lineMatches =
      queryMatchesText(dishQuery, line) ||
      queryMatchesText(dishQuery, relevantBlock) ||
      queryMatchesContext(dishQuery, relevantBlock, currentHeading);
    if (!lineMatches) continue;

    if (!line || likelyCategoryLabel(line)) continue;
    if (
      looksLikeGarbageText(line) ||
      looksLikeGarbageText(description) ||
      looksLikeGarbageText(relevantBlock)
    ) {
      continue;
    }
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

function parseLooseTextBlockHits(html: string, dishQuery: string, sourceUrl: string): MenuHit[] {
  const text = cheerio.load(html)("body").text();
  const lines = text
    .split("\n")
    .map((line) => cleanDisplayText(line))
    .filter((line) => line.length > 1 && line.length < 280 && !isSeparatorLine(line));

  const hits: MenuHit[] = [];
  const seen = new Set<string>();

  for (let i = 0; i < lines.length; i += 1) {
    const itemName = lines[i];
    if (isPriceOnlyText(itemName)) continue;
    if (looksLikeGarbageText(itemName) || looksLikeGenericItemName(itemName)) continue;
    if (!queryMatchesText(dishQuery, itemName)) continue;

    const lookahead = lines.slice(i + 1, i + 15);
    const priceLine = chooseBestPriceLine(lookahead);
    if (!priceLine) continue;

    const priceIndex = lookahead.indexOf(priceLine);
    const description = selectDescriptionAroundPrice(lookahead, priceIndex);

    const price = priceLine.startsWith("$") ? priceLine : `$${priceLine}`;
    const key = `${normalize(itemName)}|${price}`;
    if (seen.has(key)) continue;
    seen.add(key);

    hits.push({
      itemName,
      description,
      itemText: [itemName, description].filter(Boolean).join(" "),
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

function parseHiddenInputMenuHits(html: string, dishQuery: string, sourceUrl: string): MenuHit[] {
  const $ = cheerio.load(html);
  const rawFoodModel = $("#divModelFood").attr("value");
  if (!rawFoodModel) return [];

  type HiddenFood = {
    foodName?: string;
    foodPrice?: number;
    foodDesc?: string;
    active?: boolean;
    isShow?: boolean;
    isOutStock?: boolean;
  };

  let foods: HiddenFood[];
  try {
    foods = JSON.parse(rawFoodModel) as HiddenFood[];
  } catch {
    return [];
  }

  const hits: MenuHit[] = [];
  const seen = new Set<string>();

  for (const food of foods) {
    const itemName = cleanDisplayText(food.foodName || "");
    if (!itemName) continue;
    if (looksLikeGarbageText(itemName) || looksLikeGenericItemName(itemName)) continue;
    if (food.active === false || food.isShow === false || food.isOutStock === true) continue;

    const numericPrice = Number(food.foodPrice);
    if (!Number.isFinite(numericPrice) || numericPrice < 5) continue;

    const description = cleanDisplayText(food.foodDesc || "");
    if (!queryMatchesContext(dishQuery, itemName, description)) continue;
    const price = `$${numericPrice.toFixed(2)}`;
    const key = `${normalize(itemName)}|${price}`;
    if (seen.has(key)) continue;
    seen.add(key);

    hits.push({
      itemName,
      description,
      itemText: [itemName, description].filter(Boolean).join(" "),
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

function parseEmbeddedDataMenuHits(html: string, dishQuery: string, sourceUrl: string): MenuHit[] {
  const $ = cheerio.load(html);
  const query = normalize(dishQuery);
  const scripts = $("script")
    .map((_, el) => $(el).html() || "")
    .get()
    .filter(Boolean);

  const hits: MenuHit[] = [];
  const seen = new Set<string>();

  for (const script of scripts) {
    const cleaned = script
      .replace(/\\u0026/g, "&")
      .replace(/\\u003c/g, "<")
      .replace(/\\u003e/g, ">")
      .replace(/\\n/g, " ")
      .replace(/\\"/g, '"')
      .replace(/\s+/g, " ");

    const normalizedScript = normalize(cleaned);
    let searchIndex = normalizedScript.indexOf(query);

    while (searchIndex !== -1) {
      const start = Math.max(0, searchIndex - 300);
      const end = Math.min(cleaned.length, searchIndex + 500);
      const window = cleaned.slice(start, end);

      const quotedCandidates = Array.from(window.matchAll(/"([^"]{3,180})"/g))
        .map((match) => cleanDisplayText(match[1]))
        .filter((candidate) => queryMatchesText(dishQuery, candidate))
        .filter((candidate) => !looksLikeGarbageText(candidate) && !looksLikeGenericItemName(candidate));

      const itemName = quotedCandidates.sort((a, b) => a.length - b.length)[0] || cleanDisplayText(dishQuery);

      const moneyMatches = Array.from(window.matchAll(/\$\s?\d{1,2}(?:\.\d{2})?/g)).map((match) => ({
        price: match[0],
        index: match.index || 0,
      }));

      const contextualMoneyMatch = moneyMatches.find(({ index }) => {
        const snippet = window.slice(Math.max(0, index - 40), Math.min(window.length, index + 40));
        return !looksLikeModifierPriceContext(snippet);
      });

      const moneyMatch =
        (contextualMoneyMatch ? [contextualMoneyMatch.price, contextualMoneyMatch.price] : null) ||
        window.match(/"price"\s*:\s*"?(\d{3,5})"?/) ||
        window.match(/"basePrice"\s*:\s*"?(\d{3,5})"?/);

      if (!moneyMatch) {
        searchIndex = normalizedScript.indexOf(query, searchIndex + query.length);
        continue;
      }

      let price = moneyMatch[0];
      if (!price.startsWith("$")) {
        const cents = Number(moneyMatch[1] || "0");
        if (!Number.isFinite(cents) || cents <= 0) {
          searchIndex = normalizedScript.indexOf(query, searchIndex + query.length);
          continue;
        }
        price = `$${(cents / 100).toFixed(2)}`;
      } else {
        price = price.replace(/\s+/g, "");
      }

      const description = quotedCandidates.find((candidate) => candidate !== itemName) || "";
      const key = `${normalize(itemName)}|${price}`;
      if (!seen.has(key)) {
        seen.add(key);
        hits.push({
          itemName,
          description,
          itemText: [itemName, description].filter(Boolean).join(" "),
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

      searchIndex = normalizedScript.indexOf(query, searchIndex + query.length);
    }
  }

  return hits;
}

function inferSourceType(sourceUrl: string) {
  if (sourceUrl.includes("toasttab.com") || sourceUrl.includes("toast.site")) return "toast_ordering";
  if (sourceUrl.includes("spoton.com")) return "spoton_ordering";
  if (sourceUrl.includes("order.online")) return "order_online";
  return "website_or_ordering_page";
}

function parseOrderOnlineMenuHits(html: string, dishQuery: string, sourceUrl: string): MenuHit[] {
  if (!sourceUrl.includes("order.online")) return [];

  const lines = cheerio
    .load(html)("body")
    .text()
    .split("\n")
    .map((line) => cleanDisplayText(line))
    .filter((line) => line.length > 1 && line.length < 260 && !isSeparatorLine(line));

  const hits: MenuHit[] = [];
  const seen = new Set<string>();

  for (let i = 0; i < lines.length; i += 1) {
    const imageMatch = lines[i].match(/^Image:\s*(.+)$/i);
    const itemName = cleanDisplayText(imageMatch ? imageMatch[1] : lines[i]);
    if (!itemName) continue;
    if (looksLikeGarbageText(itemName) || looksLikeGenericItemName(itemName) || looksLikeMetadataText(itemName)) {
      continue;
    }

    const nextLines = lines.slice(i + 1, i + 6);
    const priceLine = chooseBestPriceLine(nextLines);
    if (!priceLine) continue;

    const description = nextLines
      .filter((candidate) => candidate !== priceLine)
      .filter(
        (candidate) =>
          !candidate.startsWith("Image:") &&
          !isPriceOnlyText(candidate) &&
          !looksLikeGarbageText(candidate) &&
          !looksLikeGenericItemName(candidate) &&
          !looksLikeMetadataText(candidate)
      )
      .map((candidate) =>
        candidate.replace(new RegExp(`^(?:${itemName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s*)+`, "i"), "").trim()
      )
      .filter(Boolean)
      .join(" ")
      .trim();
    if (!queryMatchesContext(dishQuery, itemName, description)) continue;

    const price = priceLine.startsWith("$") ? priceLine : `$${priceLine}`;
    const key = `${canonicalItemKey(itemName)}|${price}`;
    if (seen.has(key)) continue;
    seen.add(key);

    hits.push({
      itemName,
      description,
      itemText: [itemName, description].filter(Boolean).join(" "),
      price,
      sourceUrl,
      sourceType: inferSourceType(sourceUrl),
    });
  }

  return hits;
}

function parseQuickRestaurantMenuHits(html: string, dishQuery: string, sourceUrl: string): MenuHit[] {
  const $ = cheerio.load(html);
  const hits: MenuHit[] = [];
  const seen = new Set<string>();

  $(".menu-item-content-wrap").each((_, el) => {
    const itemName = cleanDisplayText($(el).find(".menu-item-title").first().text());
    if (!itemName) return;
    if (looksLikeGarbageText(itemName) || looksLikeGenericItemName(itemName) || looksLikeMetadataText(itemName)) {
      return;
    }

    const description = cleanDisplayText(
      $(el)
        .find(".menu-item-content-desc")
        .first()
        .text()
        .replace(/\bmore\b/gi, " ")
    );

    if (!queryMatchesContext(dishQuery, itemName, description)) return;

    const priceTexts = $(el)
      .find(".price-base, .price-bold, .menu-item-price, .menu-item-content-price")
      .map((__, priceEl) => cleanDisplayText($(priceEl).text()))
      .get()
      .flatMap((text) => text.match(/\$\s?\d{1,3}(?:\.\d{2})?/g) || [])
      .map((price) => price.replace(/\s+/g, ""));

    const price = chooseBestPriceLine(priceTexts);
    if (!price) return;

    const key = `${canonicalItemKey(itemName)}|${price}`;
    if (seen.has(key)) return;
    seen.add(key);

    hits.push({
      itemName,
      description,
      itemText: [itemName, description].filter(Boolean).join(" "),
      price,
      sourceUrl,
      sourceType: inferSourceType(sourceUrl),
    });
  });

  return hits;
}

function parseSourceSpecificMenuHits(html: string, dishQuery: string, sourceUrl: string) {
  const lower = sourceUrl.toLowerCase();

  if (html.includes("quick-restaurant-menu-pro") || html.includes('class="erm-menu')) {
    return parseQuickRestaurantMenuHits(html, dishQuery, sourceUrl);
  }

  if (lower.includes("order.online")) {
    return [
      ...parseOrderOnlineMenuHits(html, dishQuery, sourceUrl),
      ...parseEmbeddedDataMenuHits(html, dishQuery, sourceUrl),
    ];
  }

  return [
    ...parseHiddenInputMenuHits(html, dishQuery, sourceUrl),
    ...parseStructuredVariantMenuHits(html, dishQuery, sourceUrl),
    ...parseWixRichTextMenuHits(html, dishQuery, sourceUrl),
    ...parseEnumeratedMenuHits(html, dishQuery, sourceUrl),
    ...extractMenuHitsFromHtml(html, dishQuery, sourceUrl),
    ...parseLocalBlockMenuHits(html, dishQuery, sourceUrl),
    ...parseSequentialMenuHits(html, dishQuery, sourceUrl),
    ...parseForwardPriceMenuHits(html, dishQuery, sourceUrl),
    ...parseLooseTextBlockHits(html, dishQuery, sourceUrl),
    ...parseEmbeddedDataMenuHits(html, dishQuery, sourceUrl),
    ...parseOrderOnlineMenuHits(html, dishQuery, sourceUrl),
    ...parseLittleChihuahuaMenu(html, dishQuery, sourceUrl),
  ];
}

function sortLinksByPriority(links: string[]) {
  const priority = (link: string) => {
    const lower = link.toLowerCase();
    if (lower.includes("toasttab.com")) return 0;
    if (lower.includes("spoton.com")) return 1;
    if (lower.includes("order.online")) return 2;
    if (lower.includes("order")) return 3;
    if (lower.includes("menu")) return 4;
    return 5;
  };

  return [...links].sort((a, b) => priority(a) - priority(b));
}

function menuHitQualityScore(hit: MenuHit) {
  let score = 0;
  if (hit.itemName && !looksLikeGarbageText(hit.itemName) && !looksLikeGenericItemName(hit.itemName)) score += 5;
  if (hit.description && hit.description !== "No description available.") score += 6;
  if (hit.itemText && hit.itemText !== hit.itemName) score += 2;
  if (hit.sourceType === "toast_ordering" || hit.sourceType === "spoton_ordering") score += 1;
  return score;
}

function knownOrderingLinksForWebsite(websiteUrl: string) {
  const normalizedWebsite = normalize(websiteUrl);

  if (normalizedWebsite.includes("khobkhunsf.com")) {
    return [
      "https://order.toasttab.com/online/khob-khun-thai-cuisine-breakfast-3741-geary-blvd",
    ];
  }

  if (normalizedWebsite.includes("thaitimesf.com")) {
    return ["https://thaitime.toast.site/order"];
  }

  return [];
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
    if (looksLikeGarbageText(itemName) || looksLikeGarbageText(description) || looksLikeGarbageText(combined)) {
      continue;
    }
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

  return Array.from(urls).slice(0, MAX_LINKS_PER_SITE);
}

async function fetchText(url: string): Promise<string | null> {
  const controller = new AbortController();
  const isOrderingPlatform =
    url.includes("toasttab.com") || url.includes("spoton.com") || url.includes("blizzfull.com");
  const timeout = setTimeout(
    () => controller.abort(),
    isOrderingPlatform ? ORDERING_FETCH_TIMEOUT_MS : FETCH_TIMEOUT_MS
  );

  try {
    const res = await fetch(url, {
      headers: {
        "User-Agent":
          "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/135.0.0.0 Safari/537.36",
        Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
        "Accept-Language": "en-US,en;q=0.9",
        "Cache-Control": "no-cache",
        Pragma: "no-cache",
      },
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

async function findDishHitsForWebsite(
  websiteUrl: string,
  dish: string,
  deadlineMs?: number
): Promise<MenuHit[]> {
  const cacheKey = `${CACHE_VERSION}:menuhits:${normalize(websiteUrl)}:${normalize(dish)}`;
  const cached = await getCachedValue<MenuHit[]>(cacheKey, CACHE_DAYS);
  if (cached) return cached.value;
  const staleCached = await getAnyCachedValue<MenuHit[]>(cacheKey);

  if (deadlineMs && Date.now() >= deadlineMs) return staleCached?.value || [];

  const homeHtml = await fetchText(websiteUrl);
  if (!homeHtml) return staleCached?.value || [];

  const allHits: MenuHit[] = [];
  const visitedLinks = new Set<string>();

  // Try homepage
  allHits.push(...parseSourceSpecificMenuHits(homeHtml, dish, websiteUrl));

  // Try menu/order links (Toast/Slice/etc)
  const links = sortLinksByPriority([
    ...knownOrderingLinksForWebsite(websiteUrl),
    ...collectRelevantLinks(homeHtml, websiteUrl, dish),
  ]);
  for (const link of links) {
    if (deadlineMs && Date.now() >= deadlineMs) break;
    if (visitedLinks.has(link)) continue;
    visitedLinks.add(link);

    const html = await fetchText(link);
    if (!html) continue;
    allHits.push(...parseSourceSpecificMenuHits(html, dish, link));

    // One more level deep for category links like ?category=Vegetarian+Burritos
    const nestedLinks = sortLinksByPriority(collectRelevantLinks(html, link, dish)).slice(
      0,
      MAX_NESTED_LINKS_PER_SITE
    );
    for (const nestedLink of nestedLinks) {
      if (deadlineMs && Date.now() >= deadlineMs) break;
      if (visitedLinks.has(nestedLink)) continue;
      visitedLinks.add(nestedLink);

      const nestedHtml = await fetchText(nestedLink);
      if (!nestedHtml) continue;
      allHits.push(...parseSourceSpecificMenuHits(nestedHtml, dish, nestedLink));
    }
  }

  // Deduplicate
  const dedup = new Map<string, MenuHit>();
  for (const h of allHits) {
    const k = `${normalize(h.itemName)}|${h.price}`;
    const existing = dedup.get(k);
    if (!existing || menuHitQualityScore(h) > menuHitQualityScore(existing)) {
      dedup.set(k, h);
    }
  }

  const finalHits = Array.from(dedup.values()).slice(0, 20);
  if (finalHits.length > 0) {
    await setCachedValue(cacheKey, finalHits);
    return finalHits;
  }

  return staleCached?.value || [];
}

async function findDishHitsForKnownFallback(
  fallback: KnownRestaurantFallback,
  dish: string
): Promise<SearchResult[]> {
  const allHits: MenuHit[] = [];

  for (const sourceUrl of fallback.sourceUrls) {
    const hits = await findDishHitsForWebsite(sourceUrl, dish);
    allHits.push(...hits);
  }

  const deduped = new Map<string, MenuHit>();
  for (const hit of allHits) {
    const key = `${normalize(hit.itemName)}|${hit.price}`;
    if (!deduped.has(key)) deduped.set(key, hit);
  }

  return Array.from(deduped.values()).map((hit) => ({
    restaurantName: fallback.restaurantName,
    address: fallback.address,
    dish,
    itemName: hit.itemName,
    price: hit.price,
    description: finalizedDescription(hit),
    sourceType: hit.sourceType || "website_or_ordering_page",
    sourceUrl: hit.sourceUrl,
    websiteUrl: fallback.websiteUrl,
    googleMapsUrl: fallback.googleMapsUrl || null,
    distanceMiles: undefined,
  }));
}

function findDishHitsForManualOverride(
  override: (typeof MANUAL_RESTAURANT_OVERRIDES)[number],
  dish: string,
  center: { lat: number; lng: number }
): ManualOverrideResult {
  const diagnostics: string[] = [];
  const overrideDistance = distanceMiles(center.lat, center.lng, override.lat, override.lng);

  const matchingEntries = override.entries.filter((entry) => {
    const searchableText = [entry.itemName, entry.description, ...(entry.tags || [])].join(" ");
    return queryMatchesText(dish, searchableText);
  });

  diagnostics.push(
    `${override.restaurantName} [manual override]: entries=${override.entries.length}, matched=${matchingEntries.length}, source=${override.sourceNote}`
  );

  const results = matchingEntries.map((entry) => ({
    restaurantName: override.restaurantName,
    address: override.address,
    dish,
    itemName: entry.itemName,
    price: entry.price,
    description: entry.description || "No description available.",
    sourceType: "manual_override",
    sourceUrl: entry.sourceUrl,
    websiteUrl: override.websiteUrl,
    googleMapsUrl: override.googleMapsUrl || null,
    distanceMiles: overrideDistance,
  }));

  return { results, diagnostics };
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

async function enrichPlace(place: Place, apiKey: string) {
  if (place.websiteUri || !place.id) return place;

  const cacheKey = `${CACHE_VERSION}:place:${place.id}`;
  const cached = await getCachedValue<Place>(cacheKey, CACHE_DAYS);
  if (cached) return { ...place, ...cached.value };

  const res = await fetch(`https://places.googleapis.com/v1/places/${place.id}`, {
    headers: {
      "X-Goog-Api-Key": apiKey,
      "X-Goog-FieldMask":
        "id,displayName,formattedAddress,rating,currentOpeningHours.openNow,websiteUri,googleMapsUri,location",
    },
    cache: "no-store",
  });

  if (!res.ok) return place;
  const details = (await res.json()) as Place;
  await setCachedValue(cacheKey, details);
  return { ...place, ...details };
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

async function collectResultsForPlaces(
  places: Place[],
  dish: string,
  center: { lat: number; lng: number },
  deadlineMs?: number
) : Promise<PlaceCollectionResult> {
  const diagnostics: string[] = [];
  const results: SearchResult[] = [];

  for (let i = 0; i < places.length; i += SITE_CHECK_BATCH_SIZE) {
    if (deadlineMs && Date.now() >= deadlineMs) {
      diagnostics.push(`crawl budget exhausted after checking ${i} places`);
      break;
    }

    const batch = places.slice(i, i + SITE_CHECK_BATCH_SIZE);
    const batchResults = await Promise.all(
      batch.map(async (p) => {
        const website = p.websiteUri as string | undefined;
        if (!website) return [] as SearchResult[];

        if (deadlineMs && Date.now() >= deadlineMs) {
          diagnostics.push(`${placeLabel(p)} [crawl]: skipped due to time budget`);
          return [] as SearchResult[];
        }

        const hits = await findDishHitsForWebsite(website, dish, deadlineMs);
        diagnostics.push(`${placeLabel(p)} [crawl]: hits=${hits.length}, website=${website}`);
        if (hits.length === 0) return [] as SearchResult[];

        return hits.map((hit) => ({
          restaurantName: p.displayName?.text || "Unknown",
          address: p.formattedAddress || "",
          rating: p.rating,
          openNow: p.currentOpeningHours?.openNow,
          dish,
          itemName: hit.itemName,
          price: hit.price,
          description: finalizedDescription(hit),
          sourceType: hit.sourceType || "website_or_ordering_page",
          sourceUrl: hit.sourceUrl,
          websiteUrl: website,
          googleMapsUrl: p.googleMapsUri || null,
          distanceMiles: distanceMiles(center.lat, center.lng, p.location?.latitude, p.location?.longitude),
        }));
      })
    );

    results.push(...batchResults.flat());
  }

  return { results, diagnostics };
}

function placeLabel(place: Place) {
  return place.displayName?.text || place.formattedAddress || "Unknown";
}

function looksLikeTargetRestaurant(label: string, query: string) {
  const normalizedLabel = normalize(label);
  const normalizedQuery = normalize(query);

  if (normalizedLabel.includes("kung food")) return true;
  if (normalizedQuery.includes("general") && normalizedLabel.includes("kung food")) return true;

  return false;
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
    const searchDeadlineMs = Date.now() + SEARCH_TIME_BUDGET_MS;
    const placesCacheKey = `${CACHE_VERSION}:places:${normalize(address)}:${meters}`;
    const cachedPlaces = await getCachedValue<Place[]>(placesCacheKey, CACHE_DAYS);
    let places: Place[];

    if (cachedPlaces) {
      places = cachedPlaces.value;
    } else {
      const fieldMask =
        "places.id,places.displayName,places.formattedAddress,places.rating,places.currentOpeningHours.openNow,places.websiteUri,places.googleMapsUri,places.location";

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

      const cuisineKeyword = inferCuisineKeyword(dish);
      let cuisinePlaces: Place[] = [];

      if (cuisineKeyword) {
        const cuisineRes = await fetch("https://places.googleapis.com/v1/places:searchText", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "X-Goog-Api-Key": apiKey,
            "X-Goog-FieldMask": fieldMask,
          },
          body: JSON.stringify({
            textQuery: `${cuisineKeyword} restaurants near ${address}`,
            pageSize: 20,
            locationBias: {
              circle: {
                center: { latitude: center.lat, longitude: center.lng },
                radius: meters,
              },
            },
          }),
        });

        const cuisineJson = await cuisineRes.json();
        cuisinePlaces = cuisineRes.ok ? cuisineJson.places || [] : [];
      }

      places = dedupePlaces([
        ...dishTextPlaces,
        ...cuisinePlaces,
        ...(nearbyJson.places || []),
        ...textPlaces,
      ]);
      await setCachedValue(placesCacheKey, places);
    }

    const enrichedPlaces = await chunkedMap(places, SITE_CHECK_BATCH_SIZE, async (place) =>
      enrichPlace(place, apiKey)
    );

    const crawlablePlaces = enrichedPlaces.filter((p) => p.websiteUri);
    const firstPassPlaces = crawlablePlaces.slice(0, MAX_CANDIDATE_RESTAURANTS);
    const firstPassCollection = await collectResultsForPlaces(firstPassPlaces, dish, center, searchDeadlineMs);
    const results: SearchResult[] = firstPassCollection.results;
    const crawlDiagnostics = [...firstPassCollection.diagnostics];

    const cuisineKeyword = inferCuisineKeyword(dish);
    const applicableFallbacks = KNOWN_RESTAURANT_FALLBACKS.filter((fallback) => {
      if (cuisineKeyword && !fallback.cuisines.includes(cuisineKeyword)) return false;
      const fallbackDistance = distanceMiles(center.lat, center.lng, fallback.lat, fallback.lng);
      return withinRadius(fallbackDistance, Number(radiusMiles || 1));
    });

    const applicableManualOverrides = MANUAL_RESTAURANT_OVERRIDES.filter((override) => {
      if (
        !isRestaurantRelevantToQuery(
          override.restaurantName,
          dish,
          override.cuisines || [],
          override.sourceNote
        )
      ) {
        return false;
      }

      const overrideDistance = distanceMiles(center.lat, center.lng, override.lat, override.lng);
      return withinRadius(overrideDistance, Number(radiusMiles || 1));
    });

    for (const fallback of applicableFallbacks) {
      const alreadyPresent = results.some(
        (result) =>
          normalize(result.restaurantName) === normalize(fallback.restaurantName) ||
          normalize(result.address) === normalize(fallback.address)
      );
      if (alreadyPresent) continue;

      const fallbackResults = await findDishHitsForKnownFallback(fallback, dish);
      crawlDiagnostics.push(
        `${fallback.restaurantName} [fallback crawl]: hits=${fallbackResults.length}, sources=${fallback.sourceUrls.length}`
      );
      results.push(
        ...fallbackResults.map((result) => ({
          ...result,
          distanceMiles: distanceMiles(center.lat, center.lng, fallback.lat, fallback.lng),
        }))
      );
    }

    for (const override of applicableManualOverrides) {
      const manualOverride = findDishHitsForManualOverride(override, dish, center);
      crawlDiagnostics.push(...manualOverride.diagnostics);
      results.push(...manualOverride.results);
    }

    const requestedRadiusMiles = Number(radiusMiles || 1);
    const filteredResults = results.filter(
      (result) =>
        resultMatchesQueryStrictly(result, dish) &&
        shouldKeepResultForQuery(result, dish) &&
        !isLowConfidenceResult(result, dish) &&
        withinRadius(result.distanceMiles, requestedRadiusMiles)
    );

    const dedupedResults = new Map<string, SearchResult>();
    for (const result of filteredResults) {
      const key = `${normalize(result.address)}|${result.price}|${canonicalItemKey(result.itemName)}`;
      const directExisting = dedupedResults.get(key);
      if (!directExisting || resultQualityScore(result) > resultQualityScore(directExisting)) {
        dedupedResults.set(key, result);
      }

      for (const [existingKey, existing] of dedupedResults.entries()) {
        if (existingKey === key) continue;
        if (!resultsLookLikeSameDish(existing, result)) continue;

        if (resultQualityScore(result) > resultQualityScore(existing)) {
          dedupedResults.delete(existingKey);
          dedupedResults.set(key, result);
        }
        break;
      }
    }

    const groupedResults = new Map<string, SearchResult>();
    for (const result of dedupedResults.values()) {
      const groupKey = `${normalize(result.address)}|${canonicalItemKey(result.itemName)}`;
      const existing = groupedResults.get(groupKey);
      if (!existing) {
        groupedResults.set(groupKey, result);
        continue;
      }

      const mergedExisting = mergeResultDetails(existing, result);
      const resultScore = resultQualityScore(result);
      const existingScore = resultQualityScore(existing);
      if (
        resultScore > existingScore ||
        (resultScore === existingScore && numericPrice(result.price) < numericPrice(existing.price))
      ) {
        groupedResults.set(groupKey, mergeResultDetails(result, existing));
      } else {
        groupedResults.set(groupKey, mergedExisting);
      }
    }

    const enrichedGroupedResults = Array.from(groupedResults.values()).map((result) => {
      const hasDescription =
        Boolean(result.description) && result.description !== "No description available.";
      if (hasDescription) return result;

      const candidate = filteredResults.find((other) => {
        if (other === result) return false;
        if (normalize(other.address) !== normalize(result.address)) return false;
        if (!other.description || other.description === "No description available.") return false;
        if (!queryMatchesText(dish, other.itemName)) return false;
        return true;
      });

      return candidate ? mergeResultDetails(result, candidate) : result;
    });

    const finalResults = enrichedGroupedResults
        .sort((a, b) => {
          const priceDifference = numericPrice(a.price) - numericPrice(b.price);
          if (priceDifference !== 0) return priceDifference;

          const aDistance = a.distanceMiles ?? Number.POSITIVE_INFINITY;
          const bDistance = b.distanceMiles ?? Number.POSITIVE_INFINITY;
          return aDistance - bDistance;
        })
        .slice(0, 100);

    const checkedPlaces = results.map((result) => normalize(result.restaurantName));
    const diagnosticsSeed = [
      ...enrichedPlaces.slice(0, 20),
      ...enrichedPlaces.filter((place) => looksLikeTargetRestaurant(placeLabel(place), dish)),
    ];
    const seenDiagnosticPlaces = new Set<string>();
    const diagnosticsLines = diagnosticsSeed
      .filter((place) => {
        const key = `${normalize(placeLabel(place))}|${normalize(place.formattedAddress || "")}`;
        if (seenDiagnosticPlaces.has(key)) return false;
        seenDiagnosticPlaces.add(key);
        return true;
      })
      .map((place) => {
      const label = placeLabel(place);
      const normalizedLabel = normalize(label);
      const hasWebsite = Boolean(place.websiteUri);
      const inFirstPass = firstPassPlaces.some(
        (candidate) => normalize(placeLabel(candidate)) === normalizedLabel
      );
      const producedHit = checkedPlaces.includes(normalizedLabel);
      return `${label}: website=${hasWebsite ? "yes" : "no"}, first_pass=${inFirstPass ? "yes" : "no"}, matched=${producedHit ? "yes" : "no"}`;
    });

    for (const fallback of applicableFallbacks) {
      const fallbackMatched = finalResults.some(
        (result) => normalize(result.restaurantName) === normalize(fallback.restaurantName)
      );
      diagnosticsLines.push(
        `${fallback.restaurantName} [fallback]: in_radius=yes, matched=${fallbackMatched ? "yes" : "no"}`
      );
    }

    for (const override of applicableManualOverrides) {
      const overrideMatched = finalResults.some(
        (result) => normalize(result.restaurantName) === normalize(override.restaurantName)
      );
      diagnosticsLines.push(
        `${override.restaurantName} [manual override]: in_radius=yes, entries=${override.entries.length}, matched=${overrideMatched ? "yes" : "no"}`
      );
    }

    diagnosticsLines.push(...crawlDiagnostics.slice(0, 25));

    const responsePayload: SearchResponsePayload = {
      results: finalResults,
      note:
        "Results come from restaurant websites or ordering pages. Section matches like Burritos or Burgers can now return the priced items listed underneath.",
      diagnostics: {
        totalPlaces: places.length,
        enrichedPlaces: enrichedPlaces.length,
        crawlablePlaces: crawlablePlaces.length,
        checkedPlaces: firstPassPlaces.length,
        lines: diagnosticsLines,
      },
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
