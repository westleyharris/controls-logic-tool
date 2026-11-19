-- Controls Logic Tool: cloud machine library.
-- Every row and file belongs to the signed-in user (owner = auth.uid()); RLS enforces it.

create table if not exists public.machines (
  id uuid primary key,
  owner uuid not null default auth.uid() references auth.users (id) on delete cascade,
  name text not null,
  company text,
  line text,
  notes text,
  project_name text not null default '',
  platform text not null,
  processor text,
  file_names text[] not null default '{}',
  size bigint not null default 0,
  export_version integer not null default 1, -- bumps whenever the export files change
  added_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists machines_owner_idx on public.machines (owner);
alter table public.machines enable row level security;
create policy "machines: owner only" on public.machines
  for all to authenticated
  using (owner = (select auth.uid()))
  with check (owner = (select auth.uid()));

-- Electrical drawings, photos and other documents attached to a machine.
create table if not exists public.attachments (
  id uuid primary key,
  machine_id uuid not null references public.machines (id) on delete cascade,
  owner uuid not null default auth.uid() references auth.users (id) on delete cascade,
  kind text not null check (kind in ('drawing', 'photo', 'document')),
  name text not null,
  mime text not null,
  size bigint not null default 0,
  page_count integer,
  pages_text jsonb, -- extracted text per page, for search and the AI
  storage_path text not null,
  created_at timestamptz not null default now()
);
create index if not exists attachments_machine_idx on public.attachments (machine_id);
create index if not exists attachments_owner_idx on public.attachments (owner);
alter table public.attachments enable row level security;
create policy "attachments: owner only" on public.attachments
  for all to authenticated
  using (owner = (select auth.uid()))
  with check (owner = (select auth.uid()));

-- Small things you write down, synced between devices. Newest wins; value null = deleted.
--   scope 'links'         key = message endpoint (ip:… / name:…)  value = machine id
--   scope 'parts'         key = catalog number                     value = {status, onHand, note}
--   scope 'alarm:<id>'    key = alarm bit                          value = note text
create table if not exists public.notes (
  owner uuid not null default auth.uid() references auth.users (id) on delete cascade,
  scope text not null,
  key text not null,
  value jsonb,
  updated_at timestamptz not null default now(),
  primary key (owner, scope, key)
);
alter table public.notes enable row level security;
create policy "notes: owner only" on public.notes
  for all to authenticated
  using (owner = (select auth.uid()))
  with check (owner = (select auth.uid()));

-- Private bucket for export files and attachments: <user id>/<machine id>/...
insert into storage.buckets (id, name, public, file_size_limit)
values ('machine-files', 'machine-files', false, 52428800)
on conflict (id) do nothing;

create policy "machine-files: owner read" on storage.objects
  for select to authenticated
  using (bucket_id = 'machine-files' and (storage.foldername(name))[1] = (select auth.uid())::text);
create policy "machine-files: owner insert" on storage.objects
  for insert to authenticated
  with check (bucket_id = 'machine-files' and (storage.foldername(name))[1] = (select auth.uid())::text);
create policy "machine-files: owner update" on storage.objects
  for update to authenticated
  using (bucket_id = 'machine-files' and (storage.foldername(name))[1] = (select auth.uid())::text);
create policy "machine-files: owner delete" on storage.objects
  for delete to authenticated
  using (bucket_id = 'machine-files' and (storage.foldername(name))[1] = (select auth.uid())::text);
