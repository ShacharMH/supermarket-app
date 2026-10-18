-- One mark per receipt line: "preferred" (starred) or not. Only starred lines teach.
alter table public.receipt_items drop constraint if exists receipt_items_reason_check;
alter table public.receipt_items add constraint receipt_items_reason_check
  check (reason in ('preferred', 'deal', 'substitute', 'other'));
alter table public.receipt_items alter column reason set default 'other';
