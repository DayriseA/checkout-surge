-- Explicit experiment setup only; never created inside the buyer path.
create table if not exists proof_runs (
  run_id uuid primary key references demo_runs(id) on delete cascade,
  mode text not null check (mode in ('demo', 'no-redis', 'no-queue')),
  generation integer not null default 1,
  closed boolean not null default false
);
create table if not exists proof_inventory (
  run_id uuid primary key references proof_runs(run_id) on delete cascade,
  sale_offer_id uuid not null,
  allocated integer not null,
  remaining integer not null check (remaining >= 0),
  reserved integer not null default 0 check (reserved >= 0)
);
create table if not exists proof_holds (
  run_id uuid not null references proof_runs(run_id) on delete cascade,
  idempotency_key text not null,
  reservation_id uuid not null unique,
  hold jsonb not null,
  status text not null check (status in ('pending_persistence', 'accepted')),
  expires_at timestamptz not null,
  primary key (run_id, idempotency_key)
);
create table if not exists proof_queue (
  order_id uuid primary key references orders(id) on delete cascade,
  run_id uuid not null references proof_runs(run_id) on delete cascade,
  job jsonb not null,
  next_at timestamptz not null default now(),
  lease_until timestamptz,
  generation integer not null default 0,
  attempts integer not null default 0
);
create index if not exists proof_queue_due on proof_queue(next_at, lease_until);
create table if not exists proof_counters (
  run_id uuid not null references proof_runs(run_id) on delete cascade,
  process text not null,
  counts jsonb not null,
  primary key(run_id, process)
);

create or replace function proof_reserve(p_hold jsonb, p_key text, p_ttl integer)
returns jsonb language plpgsql as $$
declare
  v_run uuid := (p_hold->>'runId')::uuid;
  v_sale uuid := (p_hold->>'saleOfferId')::uuid;
  v_quantity integer := (p_hold->>'quantity')::integer;
  v_existing proof_holds%rowtype;
  v_decided integer;
begin
  -- Same shared run fence as durable acceptance. It is released at this statement's commit.
  perform pg_advisory_xact_lock_shared(hashtext('demo_run_finalize:' || v_run::text));
  if not exists (
    select 1 from proof_runs l join demo_runs r on r.id=l.run_id
    where l.run_id=v_run and not l.closed and r.sale_offer_id=v_sale
      and r.status in ('starting','active','draining')
  ) then
    return jsonb_build_object('outcome','run_not_accepting_traffic','reservation',null);
  end if;
  if not exists (select 1 from proof_inventory where run_id=v_run and sale_offer_id=v_sale) then
    return jsonb_build_object('outcome','inventory_not_initialized','reservation',null);
  end if;
  perform pg_advisory_xact_lock(hashtext(v_run::text || ':' || p_key));
  select * into v_existing from proof_holds where run_id=v_run and idempotency_key=p_key;
  if found then
    if (v_existing.hold->>'quantity')::integer <> v_quantity then
      return jsonb_build_object('outcome','idempotency_conflict','reservation',null);
    end if;
    return jsonb_build_object('outcome',case when v_existing.status='accepted'
      then 'idempotent_replay' else 'reservation_pending_persistence' end,
      'reservation',v_existing.hold);
  end if;
  update proof_inventory set remaining=remaining-v_quantity, reserved=reserved+v_quantity
    where run_id=v_run and sale_offer_id=v_sale and remaining>=v_quantity
    returning remaining into v_decided;
  if not found then
    return jsonb_build_object('outcome','sold_out','reservation',null);
  end if;
  insert into proof_holds values(v_run,p_key,(p_hold->>'id')::uuid,p_hold,
    'pending_persistence',now()+make_interval(secs=>p_ttl));
  return jsonb_build_object('outcome','reservation_secured','reservation',p_hold);
end $$;
