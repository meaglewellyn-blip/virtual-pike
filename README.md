# Virtual Pike

Personal operating system — Today, Week, Rhythms, People, Brain Dump, Tasks, Quotes, Weather.
One calm, beautiful place to organize life.

## Stack

- Plain HTML + CSS + vanilla JS (no build step)
- Supabase (Postgres + realtime) for cross-device sync
- localStorage for instant UI + offline tolerance
- PWA — installable on iPhone home screen
- Hosted on GitHub Pages (private repo)

## Local development

1. Open `index.html` directly in a browser, OR
2. Run a tiny static server: `python3 -m http.server 8000` from this directory and open `http://localhost:8000`

The app runs in **local-only mode** if Supabase is not configured (sync between devices is disabled, but localStorage persistence still works).

## Connecting Supabase

1. Create a new Supabase project at <https://supabase.com>
2. In the SQL editor, run:
   ```sql
   create table if not exists public.app_state (
     id text primary key,
     data jsonb not null default '{}'::jsonb,
     updated_at timestamptz not null default now()
   );

   alter table public.app_state enable row level security;

   create policy "anon read meagan row"  on public.app_state for select using (id = 'meagan');
   create policy "anon write meagan row" on public.app_state for insert with check (id = 'meagan');
   create policy "anon update meagan row" on public.app_state for update using (id = 'meagan') with check (id = 'meagan');
   ```
3. Enable realtime for the `app_state` table (Database → Replication → enable for `app_state`)
4. Open `js/db.js` and replace `SUPABASE_URL` and `SUPABASE_ANON_KEY` with the values from your project's API settings.

## Deploy to GitHub Pages

1. Push to a private repo at `meaglewellyn-blip/virtual-pike`
2. Repo settings → Pages → enable Pages from `main` branch
3. App will be at `https://meaglewellyn-blip.github.io/virtual-pike/`
4. On iPhone: open in Safari → Share → Add to Home Screen
