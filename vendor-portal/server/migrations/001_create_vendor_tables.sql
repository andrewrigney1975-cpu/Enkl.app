-- Enkl Portal's own tables. Deliberately named with a vendor_ prefix and tracked in
-- vendor_schema_migrations (see migrate.js) so this can never collide with the main app's
-- EF Core migrations / __EFMigrationsHistory table. The portal only ever reads "Organisations"
-- and "Users" (owned by the main app's schema) — it never writes to them.

CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TABLE vendor_admin (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  username text NOT NULL UNIQUE,
  password_hash text NOT NULL,
  must_change_password boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE vendor_licenses (
  org_id uuid PRIMARY KEY REFERENCES "Organisations"("Id") ON DELETE CASCADE,
  seat_cost_cents integer NOT NULL DEFAULT 0 CHECK (seat_cost_cents >= 0),
  currency text NOT NULL DEFAULT 'USD',
  discount_percent numeric(5,2) NOT NULL DEFAULT 0 CHECK (discount_percent >= 0 AND discount_percent <= 100),
  effective_from date,
  notes text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE vendor_contracts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL REFERENCES "Organisations"("Id") ON DELETE CASCADE,
  name text NOT NULL,
  status text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'active', 'expired', 'cancelled')),
  start_date date,
  end_date date,
  contract_value_cents integer NOT NULL DEFAULT 0 CHECK (contract_value_cents >= 0),
  billing_frequency text NOT NULL DEFAULT 'annual' CHECK (billing_frequency IN ('monthly', 'annual', 'one_time')),
  notes text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX vendor_contracts_org_id_idx ON vendor_contracts(org_id);
