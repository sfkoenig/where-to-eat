import { createClient, type SupabaseClient } from "@supabase/supabase-js";

type CacheRecord<T> = {
  value: T;
  cachedAt: string;
};

const inMemoryCache = new Map<string, CacheRecord<unknown>>();
let supabaseClient: SupabaseClient | null | undefined;

function getSupabaseAdmin() {
  if (supabaseClient !== undefined) return supabaseClient;

  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

  if (!url || !serviceRoleKey) {
    supabaseClient = null;
    return supabaseClient;
  }

  supabaseClient = createClient(url, serviceRoleKey, {
    auth: { autoRefreshToken: false, persistSession: false },
  });

  return supabaseClient;
}

export async function getCachedValue<T>(key: string, maxAgeDays = 30): Promise<CacheRecord<T> | null> {
  const memoryHit = inMemoryCache.get(key);
  if (memoryHit) {
    const ageMs = Date.now() - new Date(memoryHit.cachedAt).getTime();
    if (ageMs <= maxAgeDays * 24 * 60 * 60 * 1000) {
      return memoryHit as CacheRecord<T>;
    }
    inMemoryCache.delete(key);
  }

  const supabase = getSupabaseAdmin();
  if (!supabase) return null;

  const { data, error } = await supabase
    .from("search_cache")
    .select("value,cached_at")
    .eq("cache_key", key)
    .maybeSingle();

  if (error || !data) return null;

  const ageMs = Date.now() - new Date(data.cached_at).getTime();
  if (ageMs > maxAgeDays * 24 * 60 * 60 * 1000) return null;

  const record = { value: data.value as T, cachedAt: data.cached_at };
  inMemoryCache.set(key, record);
  return record;
}

export async function getAnyCachedValue<T>(key: string): Promise<CacheRecord<T> | null> {
  const memoryHit = inMemoryCache.get(key);
  if (memoryHit) {
    return memoryHit as CacheRecord<T>;
  }

  const supabase = getSupabaseAdmin();
  if (!supabase) return null;

  const { data, error } = await supabase
    .from("search_cache")
    .select("value,cached_at")
    .eq("cache_key", key)
    .maybeSingle();

  if (error || !data) return null;

  const record = { value: data.value as T, cachedAt: data.cached_at };
  inMemoryCache.set(key, record);
  return record;
}

export async function setCachedValue<T>(key: string, value: T) {
  const cachedAt = new Date().toISOString();
  const record = { value, cachedAt };
  inMemoryCache.set(key, record);

  const supabase = getSupabaseAdmin();
  if (!supabase) return;

  await supabase.from("search_cache").upsert(
    {
      cache_key: key,
      value,
      cached_at: cachedAt,
    },
    { onConflict: "cache_key" }
  );
}
