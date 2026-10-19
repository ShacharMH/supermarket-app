-- What each receipt line would cost with the store's promotions (for the receipt check).
create or replace function public.receipt_deal_prices(p_receipt bigint)
returns table (item_id bigint, deal_total numeric, deal text)
language sql stable security invoker set search_path = public as $$
  select ri.id, c.total, c.promo
  from receipt_items ri
  join receipts rc on rc.id = ri.receipt_id
  join branches b on b.id = rc.branch_id
  join prices pr on pr.branch_id = rc.branch_id and pr.barcode = ri.barcode
  cross join lateral item_cost(b.id, b.chain_id, pr.barcode, pr.price, coalesce(ri.quantity, 1),
    array(select chain_id from user_clubs)) c
  where ri.receipt_id = p_receipt and c.promo is not null
$$;
grant execute on function public.receipt_deal_prices(bigint) to authenticated;
revoke execute on function public.receipt_deal_prices(bigint) from anon, public;
