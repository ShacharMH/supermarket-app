-- Receipts as they really look: short in-store codes ("46" = cucumber at Shufersal),
-- discount lines under the item they belong to, and why an item was bought.

alter table public.receipt_items add column if not exists raw_code text;      -- the code as printed
alter table public.receipt_items add column if not exists discount numeric;   -- promotion discount for the line (positive)
alter table public.receipt_items add column if not exists promo text;         -- the discount line's text
alter table public.receipt_items add column if not exists reason text not null default 'preferred'
  check (reason in ('preferred', 'deal', 'substitute'));

-- Only what was bought by choice teaches the app what you like; deals and
-- "the usual wasn't there" purchases don't.
create or replace view public.purchase_history with (security_invoker = true) as
select ri.barcode, count(*)::int as times_bought, max(rc.purchased_at) as last_bought
from receipt_items ri join receipts rc on rc.id = ri.receipt_id
where ri.barcode is not null and ri.reason = 'preferred'
group by ri.barcode;

-- The receipt's code -> the database's barcode. Shufersal prints 1201589 for
-- 7290001201589 and 46 for its own produce code 7290000000046; other chains print
-- the full barcode. Falls back to the closest name in the same chain.
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

-- What the receipt says vs. what the price files say for that store.
create or replace function public.receipt_check(p_receipt bigint)
returns table (item_id bigint, raw_name text, barcode text, db_name text, quantity numeric, paid numeric,
               discount numeric, db_price numeric, is_weighted boolean, db_promo text)
language sql stable security invoker set search_path = public as $$
  select ri.id, ri.raw_name, ri.barcode, pr.item_name, ri.quantity, ri.price, ri.discount, pr.price,
         coalesce(p.is_weighted, false),
         (select pm.description from promotions pm join promotion_items pi on pi.promotion_pk = pm.id
          where pm.branch_id = rc.branch_id and pi.barcode = ri.barcode
            and (pm.ends_at is null or pm.ends_at >= coalesce(rc.purchased_at, now())::date) limit 1)
  from receipt_items ri
  join receipts rc on rc.id = ri.receipt_id
  left join prices pr on pr.branch_id = rc.branch_id and pr.barcode = ri.barcode
  left join products p on p.barcode = ri.barcode
  where ri.receipt_id = p_receipt
  order by ri.id
$$;
grant execute on function public.receipt_check(bigint) to authenticated;
revoke execute on function public.receipt_check(bigint) from anon, public;
