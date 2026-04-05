create table if not exists search_cache (
  cache_key text primary key,
  value jsonb not null,
  cached_at timestamptz not null default now()
);

create index if not exists idx_search_cache_cached_at on search_cache (cached_at desc);
