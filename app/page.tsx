"use client";

import { FormEvent, useMemo, useState } from "react";

type Result = {
  restaurantName: string;
  address: string;
  rating?: number;
  openNow?: boolean;
  dish: string;
  itemName?: string | null;
  price?: string | null;
  description?: string | null;
  sourceType?: string | null;
  sourceUrl?: string | null;
  websiteUrl?: string | null;
  googleMapsUrl?: string | null;
  distanceMiles?: number;
};

type SearchResponse = {
  results?: Result[];
  note?: string;
  error?: string;
};

function mapEmbedUrl(result: Result | undefined) {
  if (!result) return "";
  const query = encodeURIComponent(`${result.restaurantName} ${result.address}`);
  return `https://maps.google.com/maps?q=${query}&z=15&output=embed`;
}

export default function HomePage() {
  const [dish, setDish] = useState("pad thai");
  const [address, setAddress] = useState("123 Main St, San Francisco, CA");
  const [radiusMiles, setRadiusMiles] = useState("1");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [note, setNote] = useState("");
  const [results, setResults] = useState<Result[]>([]);
  const [selectedIndex, setSelectedIndex] = useState(0);

  function expandAddressShortcut(value: string) {
    return value.replace(/\bSF\b/gi, "San Francisco");
  }

  const selectedResult = results[selectedIndex];
  const summaryText = useMemo(() => {
    if (loading) return "Searching websites and ordering pages...";
    if (results.length === 0) return "No verified dish matches found yet.";
    return `${results.length} verified result${results.length === 1 ? "" : "s"} with price`;
  }, [loading, results.length]);

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    setLoading(true);
    setError("");
    setNote("");
    setResults([]);
    setSelectedIndex(0);

    try {
      const res = await fetch("/api/search", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ dish, address: expandAddressShortcut(address), radiusMiles }),
      });

      const data: SearchResponse = await res.json();
      if (!res.ok) throw new Error(data.error || "Search failed");

      setResults(data.results || []);
      setNote(data.note || "");
      setSelectedIndex(0);
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : "Something went wrong");
    } finally {
      setLoading(false);
    }
  }

  return (
    <main
      style={{
        minHeight: "100vh",
        padding: "32px 20px 48px",
        background:
          "radial-gradient(circle at top, rgb(255, 244, 218), rgb(248, 236, 221) 26%, rgb(243, 240, 235) 52%, rgb(233, 238, 236) 100%)",
        color: "#1e1a16",
      }}
    >
      <div style={{ maxWidth: 1180, margin: "0 auto" }}>
        <section
          style={{
            padding: 24,
            borderRadius: 24,
            background: "rgba(255,255,255,0.76)",
            border: "1px solid rgba(0,0,0,0.08)",
            boxShadow: "0 18px 50px rgba(82, 59, 34, 0.12)",
            backdropFilter: "blur(10px)",
          }}
        >
          <p
            style={{
              margin: 0,
              textTransform: "uppercase",
              letterSpacing: 1.4,
              fontSize: 12,
              color: "#8b5e34",
              fontWeight: 700,
            }}
          >
            Food Finder
          </p>
          <h1 style={{ fontSize: 48, lineHeight: 1, margin: "10px 0 12px", fontWeight: 800 }}>
            Find the actual dish, not just the restaurant.
          </h1>
          <p style={{ margin: 0, maxWidth: 720, fontSize: 18, lineHeight: 1.5, color: "#51473d" }}>
            Search from a specific address and only return menu items with a detected price from restaurant
            websites or ordering pages.
          </p>

          <form
            onSubmit={onSubmit}
            style={{
              display: "grid",
              gap: 14,
              gridTemplateColumns: "2fr 3fr 1fr auto",
              marginTop: 22,
            }}
          >
            <label style={{ display: "grid", gap: 6, fontWeight: 600 }}>
              Dish
              <input
                value={dish}
                onChange={(e) => setDish(e.target.value)}
                type="text"
                placeholder="pad thai"
                style={{
                  width: "100%",
                  padding: "14px 16px",
                  borderRadius: 14,
                  border: "1px solid rgba(0,0,0,0.14)",
                  background: "#fffdf8",
                }}
              />
            </label>

            <label style={{ display: "grid", gap: 6, fontWeight: 600 }}>
              Starting address
              <input
                value={address}
                onChange={(e) => setAddress(e.target.value)}
                type="text"
                placeholder="123 Main St, San Francisco, CA"
                style={{
                  width: "100%",
                  padding: "14px 16px",
                  borderRadius: 14,
                  border: "1px solid rgba(0,0,0,0.14)",
                  background: "#fffdf8",
                }}
              />
            </label>

            <label style={{ display: "grid", gap: 6, fontWeight: 600 }}>
              Radius
              <select
                value={radiusMiles}
                onChange={(e) => setRadiusMiles(e.target.value)}
                style={{
                  width: "100%",
                  padding: "14px 16px",
                  borderRadius: 14,
                  border: "1px solid rgba(0,0,0,0.14)",
                  background: "#fffdf8",
                }}
              >
                <option value="0.5">0.5 mile</option>
                <option value="1">1 mile</option>
                <option value="2">2 miles</option>
                <option value="5">5 miles</option>
              </select>
            </label>

            <button
              type="submit"
              style={{
                alignSelf: "end",
                border: 0,
                borderRadius: 14,
                padding: "14px 20px",
                background: "#1f6f5f",
                color: "white",
                fontWeight: 700,
                cursor: "pointer",
                minWidth: 120,
              }}
            >
              {loading ? "Searching..." : "Search"}
            </button>
          </form>
        </section>

        <section
          style={{
            display: "grid",
            gridTemplateColumns: results.length > 0 ? "1.15fr 0.85fr" : "1fr",
            gap: 18,
            marginTop: 20,
          }}
        >
          <div
            style={{
              padding: 20,
              borderRadius: 22,
              background: "rgba(255,255,255,0.78)",
              border: "1px solid rgba(0,0,0,0.08)",
              boxShadow: "0 14px 40px rgba(49, 39, 27, 0.08)",
            }}
          >
            <div
              style={{
                display: "flex",
                justifyContent: "space-between",
                gap: 12,
                alignItems: "center",
                flexWrap: "wrap",
                marginBottom: 16,
              }}
            >
              <div>
                <h2 style={{ margin: 0, fontSize: 28 }}>Results</h2>
                <p style={{ margin: "6px 0 0", color: "#64574a" }}>{summaryText}</p>
              </div>
              {results.length > 0 ? (
                <a
                  href={`https://www.google.com/maps/search/${encodeURIComponent(`${dish} near ${address}`)}`}
                  target="_blank"
                  rel="noreferrer"
                  style={{ color: "#145b7d", fontWeight: 700 }}
                >
                  Open search in Google Maps
                </a>
              ) : null}
            </div>

            {error ? (
              <p
                style={{
                  margin: "0 0 14px",
                  padding: "12px 14px",
                  borderRadius: 14,
                  background: "#fff0ee",
                  color: "#912b18",
                }}
              >
                {error}
              </p>
            ) : null}

            {note ? <p style={{ margin: "0 0 16px", color: "#64574a" }}>{note}</p> : null}

            <div style={{ display: "grid", gap: 14 }}>
              {results.map((r, i) => (
                <button
                  key={`${r.restaurantName}-${r.itemName}-${r.price}-${i}`}
                  type="button"
                  onClick={() => setSelectedIndex(i)}
                  style={{
                    textAlign: "left",
                    border: i === selectedIndex ? "2px solid #1f6f5f" : "1px solid rgba(0,0,0,0.12)",
                    borderRadius: 18,
                    padding: 18,
                    background: i === selectedIndex ? "#f2fbf8" : "#fffdfa",
                    cursor: "pointer",
                    boxShadow: i === selectedIndex ? "0 10px 24px rgba(31,111,95,0.12)" : "none",
                  }}
                >
                  <div
                    style={{
                      display: "flex",
                      justifyContent: "space-between",
                      gap: 12,
                      alignItems: "flex-start",
                      flexWrap: "wrap",
                    }}
                  >
                    <div>
                      <h3 style={{ margin: 0, fontSize: 24 }}>{r.itemName || r.dish}</h3>
                      <p style={{ margin: "4px 0 0", color: "#6f6255" }}>
                        {r.restaurantName}
                        {typeof r.distanceMiles === "number" ? ` • ${r.distanceMiles} mi away` : ""}
                      </p>
                    </div>
                    <div
                      style={{
                        padding: "8px 10px",
                        borderRadius: 999,
                        background: "#1e1a16",
                        color: "white",
                        fontWeight: 800,
                        fontSize: 18,
                      }}
                    >
                      {r.price}
                    </div>
                  </div>

                  <p style={{ margin: "12px 0 8px", color: "#43382f", lineHeight: 1.5 }}>
                    {r.description || "No description available."}
                  </p>

                  <div
                    style={{
                      display: "flex",
                      flexWrap: "wrap",
                      gap: 8,
                      marginBottom: 10,
                    }}
                  >
                    <span
                      style={{
                        padding: "6px 10px",
                        borderRadius: 999,
                        background: "#f0e1cb",
                        fontSize: 13,
                        fontWeight: 700,
                      }}
                    >
                      Verified price
                    </span>
                    <span
                      style={{
                        padding: "6px 10px",
                        borderRadius: 999,
                        background: "#ece7e1",
                        fontSize: 13,
                        fontWeight: 700,
                      }}
                    >
                      {typeof r.openNow === "boolean" ? (r.openNow ? "Open now" : "Closed now") : "Hours unknown"}
                    </span>
                    {typeof r.rating === "number" ? (
                      <span
                        style={{
                          padding: "6px 10px",
                          borderRadius: 999,
                          background: "#ece7e1",
                          fontSize: 13,
                          fontWeight: 700,
                        }}
                      >
                        Rating {r.rating}
                      </span>
                    ) : null}
                  </div>

                  <p style={{ margin: "0 0 12px", color: "#6f6255" }}>{r.address}</p>

                  <div style={{ display: "flex", gap: 14, flexWrap: "wrap" }}>
                    {r.websiteUrl ? (
                      <a href={r.websiteUrl} target="_blank" rel="noreferrer" style={{ color: "#145b7d" }}>
                        Website
                      </a>
                    ) : null}
                    {r.googleMapsUrl ? (
                      <a href={r.googleMapsUrl} target="_blank" rel="noreferrer" style={{ color: "#145b7d" }}>
                        Google Maps
                      </a>
                    ) : null}
                    {r.sourceUrl ? (
                      <a href={r.sourceUrl} target="_blank" rel="noreferrer" style={{ color: "#145b7d" }}>
                        Source page
                      </a>
                    ) : null}
                  </div>
                </button>
              ))}
            </div>
          </div>

          {results.length > 0 ? (
            <aside
              style={{
                padding: 18,
                borderRadius: 22,
                background: "rgba(255,255,255,0.78)",
                border: "1px solid rgba(0,0,0,0.08)",
                boxShadow: "0 14px 40px rgba(49, 39, 27, 0.08)",
                alignSelf: "start",
                position: "sticky",
                top: 18,
              }}
            >
              <h2 style={{ margin: "0 0 10px", fontSize: 24 }}>Map view</h2>
              {selectedResult ? (
                <>
                  <p style={{ margin: "0 0 12px", color: "#53483d" }}>
                    {selectedResult.itemName || selectedResult.dish} at {selectedResult.restaurantName}
                  </p>
                  <div style={{ borderRadius: 18, overflow: "hidden", border: "1px solid rgba(0,0,0,0.12)" }}>
                    <iframe
                      title="Selected restaurant map"
                      src={mapEmbedUrl(selectedResult)}
                      width="100%"
                      height="360"
                      style={{ border: 0, display: "block" }}
                      loading="lazy"
                      referrerPolicy="no-referrer-when-downgrade"
                    />
                  </div>
                  <p style={{ margin: "12px 0 0", color: "#64574a", lineHeight: 1.5 }}>
                    Click a result card to focus its map. If the embedded map does not load for a specific place,
                    use that card’s Google Maps link instead.
                  </p>
                </>
              ) : null}
            </aside>
          ) : null}
        </section>
      </div>
    </main>
  );
}
