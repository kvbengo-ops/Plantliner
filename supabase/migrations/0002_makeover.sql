-- Run once in the Supabase dashboard: SQL Editor -> New query -> paste -> Run. Run it BEFORE deploying the code that uses it:
-- every new visualization row (single or makeover) is inserted with these columns.
-- Total plant makeover: which mode a row is, the designer's checked layout plan, and its plain-text rationale.
-- `items` already holds [{ productId, quantity }], and finish_visualization returns whole rows, so nothing else changes.
alter table visualizations
  add column mode text not null default 'single' check (mode in ('single', 'makeover')),
  add column plan jsonb,
  add column rationale text;
