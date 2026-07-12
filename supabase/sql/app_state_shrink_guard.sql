-- Shrink guard for app_state: rejects stale-device wholesale overwrites.
--
-- Pathology (four incidents, 2026-07-11/12): a resumed PWA running frozen
-- day-old code+data pushes its entire stale blob, silently reverting
-- everything newer. Such writes always SHRINK several sections at once
-- (missing days of synced transactions, quotes, rules, bills). Healthy
-- writes only ever shrink a list by one or two (a delete, an archive).
--
-- This trigger rejects any UPDATE that shrinks a tracked section by more
-- than 3 items. The rejected client gets an error (its push fails, no data
-- lost anywhere); on next true reload it pulls fresh state.
--
-- Escape hatch for intentional mass deletion:
--   alter table public.app_state disable trigger app_state_shrink_guard;
--   ... do the write ...
--   alter table public.app_state enable trigger app_state_shrink_guard;

create or replace function public.app_state_shrink_guard()
returns trigger
language plpgsql
as $$
declare
  s text;
  oldn int;
  newn int;
begin
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
