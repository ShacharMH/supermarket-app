-- Every shelf name of the products the user starred: the catalogue keeps one generic
-- name ("שוקולד לינדט אקסלנס") while the shelves say what it is ("שוק.מריר לינדט 90% 100ג").
create or replace function public.bought_product_names()
returns table (barcode text, item_name text)
language sql stable security invoker set search_path = public as $$
  select distinct pr.barcode, pr.item_name
  from purchase_history h join prices pr on pr.barcode = h.barcode
  where pr.item_name is not null
$$;
grant execute on function public.bought_product_names() to authenticated;
revoke execute on function public.bought_product_names() from anon, public;
