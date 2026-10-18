-- Products the user bought by choice, shaped like search_products results, so a
-- product with a shortened shelf name ("שוק.מריר לינדט 90%") still joins the list
-- term it belongs to ("שוקולד מריר 90%").
create or replace function public.bought_products()
returns table (
  barcode text, name text, manufacturer text, quantity numeric, unit_of_measure text,
  is_weighted boolean, branches int, min_price numeric, max_price numeric
)
language sql stable security invoker set search_path = public as $$
  select p.barcode, p.name, p.manufacturer, p.quantity, p.unit_of_measure, p.is_weighted,
         count(pr.branch_id)::int, min(pr.price), max(pr.price)
  from purchase_history h
  join products p on p.barcode = h.barcode
  left join prices pr on pr.barcode = p.barcode
  group by p.barcode, p.name, p.manufacturer, p.quantity, p.unit_of_measure, p.is_weighted
$$;
grant execute on function public.bought_products() to authenticated;
revoke execute on function public.bought_products() from anon, public;
