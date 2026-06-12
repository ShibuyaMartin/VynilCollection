-- Vinilos: multi-user social schema.
-- Run this once in the Supabase SQL editor (Dashboard -> SQL Editor).
-- Stage 1 tables (profiles, records) and Stage 2 tables (likes, comments,
-- pings) are created together; unused tables cost nothing.

-- ===== Stage 1 ==============================================================

create table public.profiles (
  id           uuid primary key references auth.users(id) on delete cascade,
  username     text not null unique
               check (username ~ '^[a-z0-9](?:[a-z0-9-]{1,28}[a-z0-9])?$'),
  display_name text not null default '',
  bio          text not null default '',
  created_at   timestamptz not null default now()
);
-- NOTE: emails live only in auth.users, never here.

create table public.records (
  id                 uuid primary key default gen_random_uuid(),
  owner_id           uuid not null references public.profiles(id) on delete cascade,
  position           int  not null,                  -- per-user collection number
  artist             text not null,
  title              text not null,
  year               int,
  label              text not null default '',
  catalog_number     text not null default '',
  country            text not null default '',
  cover_condition    text not null default 'VG+',
  disc_condition     text not null default 'VG+',
  barcode            text,
  comment            text,
  genres             text[] not null default '{}',
  styles             text[] not null default '{}',
  formats            text[] not null default '{}',
  tracklist          jsonb  not null default '[]',
  discogs_release_id text,
  discogs_url        text not null default '',
  cover_path         text,                           -- storage: <owner_id>/<record_id>.jpg
  search_text        text not null default '',
  added_via          text not null default 'barcode-scan',
  created_at         timestamptz not null default now(),
  unique (owner_id, position)
);

create index records_owner_idx on public.records (owner_id, position);

alter table public.profiles enable row level security;
alter table public.records  enable row level security;

create policy "profiles are public"  on public.profiles for select using (true);
create policy "create own profile"   on public.profiles for insert with check (id = auth.uid());
create policy "update own profile"   on public.profiles for update using (id = auth.uid());

create policy "records are public"   on public.records for select using (true);
create policy "insert own records"   on public.records for insert with check (owner_id = auth.uid());
create policy "update own records"   on public.records for update using (owner_id = auth.uid());
create policy "delete own records"   on public.records for delete using (owner_id = auth.uid());

-- ===== Stage 2 (social) =====================================================

create table public.likes (
  record_id  uuid not null references public.records(id) on delete cascade,
  user_id    uuid not null references public.profiles(id) on delete cascade,
  created_at timestamptz not null default now(),
  primary key (record_id, user_id)
);

create table public.comments (
  id         uuid primary key default gen_random_uuid(),
  record_id  uuid not null references public.records(id) on delete cascade,
  author_id  uuid not null references public.profiles(id) on delete cascade,
  body       text not null check (char_length(body) between 1 and 1000),
  created_at timestamptz not null default now()
);

create index comments_record_idx on public.comments (record_id, created_at);

create table public.pings (
  id         uuid primary key default gen_random_uuid(),
  record_id  uuid not null references public.records(id) on delete cascade,
  sender_id  uuid not null references public.profiles(id) on delete cascade,
  message    text check (char_length(message) <= 500),
  created_at timestamptz not null default now()
);

create index pings_sender_idx on public.pings (sender_id, created_at);

alter table public.likes    enable row level security;
alter table public.comments enable row level security;
alter table public.pings    enable row level security;

create policy "likes are public"     on public.likes    for select using (true);
create policy "like as yourself"     on public.likes    for insert with check (user_id = auth.uid());
create policy "unlike your likes"    on public.likes    for delete using (user_id = auth.uid());

create policy "comments are public"  on public.comments for select using (true);
create policy "comment as yourself"  on public.comments for insert with check (author_id = auth.uid());
create policy "delete own or on own record" on public.comments for delete
  using (author_id = auth.uid()
         or exists (select 1 from public.records r
                    where r.id = record_id and r.owner_id = auth.uid()));

-- Pings: NO public select; senders see their own. There is intentionally no
-- insert policy — pings are inserted only by the server (service role) so the
-- rate limit cannot be bypassed.
create policy "see own sent pings"   on public.pings    for select using (sender_id = auth.uid());

-- ===== Follows ==============================================================

create table public.follows (
  follower_id  uuid not null references public.profiles(id) on delete cascade,
  following_id uuid not null references public.profiles(id) on delete cascade,
  created_at   timestamptz not null default now(),
  primary key (follower_id, following_id),
  check (follower_id <> following_id)
);

alter table public.follows enable row level security;

create policy "follows are public"  on public.follows for select using (true);
create policy "follow as yourself"  on public.follows for insert with check (follower_id = auth.uid());
create policy "unfollow yourself"   on public.follows for delete using (follower_id = auth.uid());

-- ===== Places (stores, fairs, listening cafés) ==============================

create table public.places (
  id         uuid primary key default gen_random_uuid(),
  osm_id     text unique,
  added_by   uuid references public.profiles(id) on delete set null,
  name       text not null check (char_length(name) <= 120),
  kind       text not null check (kind in ('store', 'fair', 'cafe')),
  city       text,
  country    text,
  lat        double precision not null,
  lng        double precision not null,
  website    text check (char_length(website) <= 300),
  created_at timestamptz not null default now()
);

create table public.place_reviews (
  place_id   uuid not null references public.places(id) on delete cascade,
  author_id  uuid not null references public.profiles(id) on delete cascade,
  rating     int not null check (rating between 1 and 5),
  body       text check (char_length(body) <= 1000),
  created_at timestamptz not null default now(),
  primary key (place_id, author_id)
);

alter table public.places        enable row level security;
alter table public.place_reviews enable row level security;

create policy "places are public"     on public.places        for select using (true);
create policy "add places signed in"  on public.places        for insert with check (added_by = auth.uid());
create policy "reviews are public"    on public.place_reviews for select using (true);
create policy "review as yourself"    on public.place_reviews for insert with check (author_id = auth.uid());
create policy "edit own review"       on public.place_reviews for update using (author_id = auth.uid());
create policy "delete own review"     on public.place_reviews for delete using (author_id = auth.uid());

-- ===== Storage ==============================================================
-- Create a PUBLIC bucket named exactly `covers` in Dashboard -> Storage.
-- No storage policies needed: writes are service-role only, reads are public.
