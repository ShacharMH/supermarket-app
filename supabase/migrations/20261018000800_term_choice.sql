-- What matters for a list term, as chosen in the item sheet: the cheapest of all,
-- the cheapest of some brands (term_settings.brands), or one product (product_preferences).
alter table public.term_settings add column if not exists choice text check (choice in ('cheapest', 'brands', 'product'));
