-- Re-running a receipt also folds old discount lines into the item above them.
create or replace function public.resolve_receipt(p_receipt bigint)
returns int
language plpgsql security invoker set search_path = public, extensions as $$
declare
  v_chain text;
  v_count int := 0;
  r record;
  v_barcode text;
  v_codes text[];
begin
  select b.chain_id into v_chain
  from receipts rc left join branches b on b.id = rc.branch_id
  where rc.id = p_receipt;

  -- receipts saved before discount lines were understood: fold each into the item above
  for r in select id, raw_name, price from receipt_items
           where receipt_id = p_receipt and price < 0 order by id
  loop
    update receipt_items
      set discount = coalesce(discount, 0) - r.price,
          promo = coalesce(promo || '; ', '') || r.raw_name,
          reason = 'deal'
      where id = (select max(id) from receipt_items
                  where receipt_id = p_receipt and id < r.id and coalesce(price, 0) >= 0);
    if found then
      delete from receipt_items where id = r.id;
    end if;
  end loop;

  for r in
    select id, raw_name, coalesce(raw_code, barcode) as code
    from receipt_items where receipt_id = p_receipt
  loop
    v_barcode := null;
    if r.code ~ '^\d+$' then
      v_codes := array[r.code, ltrim(r.code, '0'), '729' || lpad(ltrim(r.code, '0'), 10, '0')];
      select pr.barcode into v_barcode
      from prices pr join branches b on b.id = pr.branch_id
      where pr.barcode = any(v_codes || array(select v_chain || ':' || c from unnest(v_codes) c))
      order by (b.chain_id = v_chain) desc nulls last
      limit 1;
    end if;
    if v_barcode is null then
      select pr.barcode into v_barcode
      from prices pr join branches b on b.id = pr.branch_id
      where norm_text(pr.item_name) % norm_text(r.raw_name)
      order by (b.chain_id = v_chain) desc nulls last,
               similarity(norm_text(pr.item_name), norm_text(r.raw_name)) desc
      limit 1;
    end if;
    update receipt_items
      set raw_code = coalesce(raw_code, case when r.code is distinct from v_barcode then r.code end),
          barcode = v_barcode
      where id = r.id;
    if v_barcode is not null then
      v_count := v_count + 1;
    end if;
  end loop;
  return v_count;
end $$;

