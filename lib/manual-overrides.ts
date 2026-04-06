export type ManualMenuOverrideEntry = {
  itemName: string;
  description: string;
  price: string;
  sourceUrl: string;
  tags?: string[];
};

export type ManualRestaurantOverride = {
  restaurantName: string;
  address: string;
  lat: number;
  lng: number;
  websiteUrl: string;
  googleMapsUrl?: string | null;
  sourceNote: string;
  cuisines?: string[];
  entries: ManualMenuOverrideEntry[];
};

export const MANUAL_RESTAURANT_OVERRIDES: ManualRestaurantOverride[] = [
  {
    restaurantName: "Hayz Dog",
    address: "364 Hayes St, San Francisco, CA 94102, USA",
    lat: 37.777153,
    lng: -122.423231,
    websiteUrl: "https://www.hayzdogsf.com/menu",
    googleMapsUrl: null,
    sourceNote:
      "Public Squarespace menu exposes item text but not prices. Add manually verified priced items here when available.",
    cuisines: ["hot dog", "american"],
    entries: [],
  },
];
