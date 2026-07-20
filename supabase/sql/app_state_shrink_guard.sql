-- Write guards for app_state: rejects stale-device wholesale overwrites.
-- v2 (2026-07-20): adds the pushStamp fence on top of the shrink checks.
--
-- Pathology (five incidents, 2026-07-11 through 2026-07-20): a device
-- running frozen cached code and/or frozen local data pushes its entire
-- stale blob, silently reverting everything newer. The shrink checks catch
-- the common shape (sections losing many items at once); the pushStamp
-- fence closes the rest of the door:
--
--   Every healthy client (db.js v10+) stamps data.meta.pushStamp with the
--   push wall-clock time immediately before upserting. This trigger rejects
--   any UPDATE whose blob carries no stamp, or a stamp more than 48 hours
--   older than the server clock. A stale device re-pushing days-old data
--   carries a days-old (or missing) stamp and is refused at the database —
--   no matter how old its cached JavaScript is, because old code cannot
--   fake a field it has never heard of.
--
-- Escape hatch for intentional maintenance writes:
--   alter table public.app_state disable trigger app_state_shrink_guard;
--   ... do the write ...
--   alter table public.app_state enable trigger app_state_shrink_guard;
-- (Direct maintenance PATCHes should instead just include a current
--  data.meta.pushStamp and, if shrinking, use the escape hatch.)

create or replace function public.app_state_shrink_guard()
returns trigger
language plpgsql
as $$
declare
  s text;
  oldn int;
  newn int;
  stamp timestamptz;
begin
  -- ── pushStamp fence ──────────────────────────────────────────────────
  begin
    stamp := (new.data->'meta'->>'pushStamp')::timestamptz;
  exception when others then
    stamp := null;
  end;
  if stamp is null then
    raise exception 'stale write rejected: blob has no meta.pushStamp (old client code)';
  end if;
  if stamp < now() - interval '48 hours' then
    raise exception 'stale write rejected: meta.pushStamp % is older than 48h', stamp;
  end if;

  -- ── shrink checks ────────────────────────────────────────────────────
  foreach s in array array['quotes','people','brainDump','tasks','reminders','trips','rhythms'] loop
    oldn := coalesce(jsonb_array_length(old.data->s), 0);
    newn := coalesce(jsonb_array_length(new.data->s), 0);
    if newn < oldn - 3 then
      raise exception 'stale write rejected: % would shrink from % to %', s, oldn, newn;
    end if;
  end loop;

  if (old.data ? 'budget') and (new.data ? 'budget') then
    foreach s in array array['transactions','rules','recurringBills','payPeriods','accounts','debts','categories'] loop
      oldn := coalesce(jsonb_array_length(old.data->'budget'->s), 0);
      newn := coalesce(jsonb_array_length(new.data->'budget'->s), 0);
      if newn < oldn - 3 then
        raise exception 'stale write rejected: budget.% would shrink from % to %', s, oldn, newn;
      end if;
    end loop;
  end if;

  return new;
end;
$$;

drop trigger if exists app_state_shrink_guard on public.app_state;
create trigger app_state_shrink_guard
  before update on public.app_state
  for each row
  execute function public.app_state_shrink_guard();
