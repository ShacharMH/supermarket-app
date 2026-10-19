-- Catalogue entries no tracked store sells any more (left behind when a store leaves
-- tracking). Products in the user's receipts or choices are kept.
create or replace function public.prune_products()
returns int
language sql volatile security invoker set search_path = public as $$
  with gone as (
    delete from products p
    where not exists (select 1 from prices pr where pr.barcode = p.barcode)
      and not exists (select 1 from receipt_items ri where ri.barcode = p.barcode)
      and not exists (select 1 from product_preferences pp where pp.barcode = p.barcode)
    returning 1
  )
  select count(*)::int from gone
$$;
revoke execute on function public.prune_products() from anon, authenticated, public;
