-- Receipt import: match receipt line names to barcodes.
-- Receipts print the chain's own item name, which is exactly prices.item_name,
-- so a trigram match against the same chain's items is usually decisive.

create or replace function public.resolve_receipt(p_receipt bigint)
returns int
language plpgsql security invoker set search_path = public, extensions as $$
declare
  v_chain text;
  v_count int := 0;
  r record;
  v_barcode text;
begin
  select b.chain_id into v_chain
  from receipts rc left join branches b on b.id = rc.branch_id
  where rc.id = p_receipt;

  for r in select id, raw_name from receipt_items where receipt_id = p_receipt and barcode is null loop
    select pr.barcode into v_barcode
    from prices pr join branches b on b.id = pr.branch_id
    where norm_text(pr.item_name) % norm_text(r.raw_name)
    order by (b.chain_id = v_chain) desc nulls last,
             similarity(norm_text(pr.item_name), norm_text(r.raw_name)) desc
    limit 1;
    if v_barcode is not null then
      update receipt_items set barcode = v_barcode where id = r.id;
      v_count := v_count + 1;
    end if;
  end loop;
  return v_count;
end $$;

create index if not exists prices_item_name_trgm_idx
  on public.prices using gin (public.norm_text(item_name) extensions.gin_trgm_ops);

-- Barcodes the user has bought, with counts (used as default preferences).
create or replace view public.purchase_history with (security_invoker = true) as
select ri.barcode, count(*)::int as times_bought, max(rc.purchased_at) as last_bought
from receipt_items ri join receipts rc on rc.id = ri.receipt_id
where ri.barcode is not null
group by ri.barcode;

grant execute on function public.resolve_receipt(bigint) to authenticated;
revoke execute on function public.resolve_receipt(bigint) from anon, public;
grant select on public.purchase_history to authenticated;
