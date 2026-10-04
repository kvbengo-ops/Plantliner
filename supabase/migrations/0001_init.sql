-- Run once in the Supabase dashboard: SQL Editor → New query → paste → Run.
-- Everything is reached only through the Vercel `api/` functions using the service-role key.
-- Row level security is on with no policies, so the public anon key can read and write nothing.

create table visualizations (
  id text primary key,                 -- 20 letters/digits; also the share-link id
  status text not null check (status in ('processing', 'succeeded', 'failed')),
  items jsonb not null,                -- [{ productId, quantity }]; an array so a future "AI Designer" can add several plants
  space_type text not null,
  style text not null,
  placement text not null,
  dims jsonb not null default '{}',
  aspect text not null,                -- the Kie ratio sent: nearest the room photo's own shape
  provider text not null,
  model text not null,
  task_id text,
  prompt text not null,
  error text,
  ip_key text not null,                -- daily-rotating hash, never the IP itself
  created_at bigint not null,          -- epoch ms
  checked_at bigint not null,
  completed_at bigint,
  expires_at bigint not null           -- the daily cleanup (api/cron/cleanup) deletes the row and its images after this
);

create table enquiries (
  id text primary key,
  space text not null,
  light text not null default '',
  size text not null default '',
  notes text not null default '',
  name text not null,
  contact_method text not null check (contact_method in ('Email', 'Phone')),
  contact text not null,
  product_id text,
  visualization_id text,
  photo_path text,
  created_at bigint not null
);

-- `key` is either a UTC day ('2026-10-04') for the daily total, or '<day>_<hash>' for one visitor.
create table usage_counts (
  key text primary key,
  count int not null default 0
);

alter table visualizations enable row level security;
alter table enquiries enable row level security;
alter table usage_counts enable row level security;

-- Private bucket: images are only ever handed out as short-lived signed URLs.
insert into storage.buckets (id, name, public) values ('plantliner', 'plantliner', false) on conflict (id) do nothing;

-- Takes one slot from the daily total and the visitor's own count, or none at all. Locks both rows, so concurrent calls cannot overshoot a cap.
create function take_slot(p_day text, p_ip_key text, p_daily int, p_ip int) returns boolean
language plpgsql as $$
begin
  insert into usage_counts (key) values (p_day), (p_ip_key) on conflict do nothing;
  perform 1 from usage_counts where key in (p_day, p_ip_key) order by key for update;
  if (select count from usage_counts where key = p_day) >= p_daily
     or (select count from usage_counts where key = p_ip_key) >= p_ip then
    return false;
  end if;
  update usage_counts set count = count + 1 where key in (p_day, p_ip_key);
  return true;
end $$;

-- Only the visitor's own slot comes back; the daily total counts every attempt, because attempts may cost money.
create function refund_slot(p_ip_key text) returns void
language sql as $$
  update usage_counts set count = greatest(count - 1, 0) where key = p_ip_key;
$$;

-- Moves a visualization from 'processing' to a final state exactly once. A concurrent call that loses the race
-- gets the winner's row back, and the slot refund happens in the same transaction, so it can never be paid twice.
create function finish_visualization(p_id text, p_status text, p_error text, p_refund boolean) returns visualizations
language plpgsql as $$
declare v visualizations;
begin
  update visualizations
    set status = p_status, error = p_error, completed_at = (extract(epoch from now()) * 1000)::bigint
    where id = p_id and status = 'processing'
    returning * into v;
  if found then
    if p_refund then update usage_counts set count = greatest(count - 1, 0) where key = v.ip_key; end if;
  else
    select * into v from visualizations where id = p_id;
  end if;
  return v;
end $$;

-- PostgREST exposes public functions to the anon key by default; only the server's service role may call these.
revoke execute on function take_slot(text, text, int, int) from public, anon, authenticated;
revoke execute on function refund_slot(text) from public, anon, authenticated;
revoke execute on function finish_visualization(text, text, text, boolean) from public, anon, authenticated;
