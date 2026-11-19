-- Slate presentation fields used by the app and operator console,
-- plus the player's state on their profile.

alter table public.games
  add column home_name text,
  add column away_name text,
  add column home_color text check (home_color ~ '^#[0-9a-f]{6}$'),
  add column away_color text check (away_color ~ '^#[0-9a-f]{6}$');

alter table public.projections
  add column jersey smallint check (jersey between 0 and 99),
  add column special boolean not null default false,
  add column note text check (char_length(note) <= 140);

alter table public.profiles
  add column state char(2) check (state ~ '^[A-Z]{2}$');

-- Settlement uses entry status 'refunded' and leg results 'push'/'void'; expose
-- settled picks' final values to their owners (already covered by RLS on entry_picks).

-- Operators may correct a line before anyone has played it; once an entry exists,
-- players keep the line they locked in (entry_picks.line), so later edits never
-- change a placed entry.
