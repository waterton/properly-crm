-- Hard money lending — loans you've made as a lender, plus payments received.
-- Separate from the rental ledger (inv_ledger). Run once in the Supabase SQL editor, then deploy.

create table if not exists inv_loans (
  id                 bigint primary key,
  borrower           text,
  address            text,          -- secured property, if any
  notes              text,
  principal          numeric,
  interest_rate      numeric,       -- annual %, if known
  term_months        int,
  start_date         text,
  end_date           text,          -- maturity
  first_payment_date text,
  monthly_payment    numeric,       -- scheduled monthly interest payment
  status             text,          -- active | paid off | default
  created_at         timestamptz default now()
);

create table if not exists inv_loan_payments (
  id         bigint primary key,
  loan_id    bigint,               -- -> inv_loans.id
  date       text,                 -- YYYY-MM-DD of the scheduled/received payment
  amount     numeric,
  note       text,
  created_at timestamptz default now()
);

-- One payment record per loan per month (marking a scheduled month paid is idempotent).
create unique index if not exists inv_loan_payments_month_uidx
  on inv_loan_payments (loan_id, date) where date is not null;

alter table inv_loans          enable row level security;
alter table inv_loan_payments  enable row level security;

create policy "inv_loans authenticated"         on inv_loans         for all using (auth.role() = 'authenticated') with check (auth.role() = 'authenticated');
create policy "inv_loan_payments authenticated" on inv_loan_payments for all using (auth.role() = 'authenticated') with check (auth.role() = 'authenticated');
