-- Idempotent schema: safe to run on every start-up.
-- Money is stored as BIGINT minor units (paise/cents) so arithmetic is exact.

CREATE TABLE IF NOT EXISTS accounts (
  id            UUID PRIMARY KEY,
  name          VARCHAR(100) NOT NULL CHECK (length(trim(name)) > 0),
  balance_minor BIGINT NOT NULL DEFAULT 0 CHECK (balance_minor >= 0),
  created_at    TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp()
);

-- Cap balances at 2^53 - 1 minor units: the largest integer JavaScript represents exactly.
-- Added separately so existing databases pick it up too.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'accounts_balance_max') THEN
    ALTER TABLE accounts ADD CONSTRAINT accounts_balance_max CHECK (balance_minor <= 9007199254740991);
  END IF;
END $$;

CREATE TABLE IF NOT EXISTS transfers (
  id              UUID PRIMARY KEY,
  from_account_id UUID NOT NULL REFERENCES accounts(id),
  to_account_id   UUID NOT NULL REFERENCES accounts(id),
  amount_minor    BIGINT NOT NULL CHECK (amount_minor > 0),
  description     VARCHAR(255),
  reference_id    VARCHAR(100) NOT NULL,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  CHECK (from_account_id <> to_account_id)
);

CREATE TABLE IF NOT EXISTS transactions (
  -- seq is a stable insertion order, used as tie-breaker when created_at is equal.
  seq           BIGSERIAL UNIQUE,
  id            UUID PRIMARY KEY,
  account_id    UUID NOT NULL REFERENCES accounts(id),
  type          VARCHAR(6) NOT NULL CHECK (type IN ('credit', 'debit')),
  amount_minor  BIGINT NOT NULL CHECK (amount_minor > 0),
  description   VARCHAR(255),
  reference_id  VARCHAR(100) NOT NULL CHECK (length(trim(reference_id)) > 0),
  transfer_id   UUID REFERENCES transfers(id),
  created_at    TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  -- Idempotency: a reference is unique per account, but may repeat across accounts.
  CONSTRAINT transactions_account_reference_unique UNIQUE (account_id, reference_id)
);

CREATE INDEX IF NOT EXISTS idx_transactions_history
  ON transactions (account_id, created_at DESC, seq DESC);
CREATE INDEX IF NOT EXISTS idx_transactions_history_by_type
  ON transactions (account_id, type, created_at DESC, seq DESC);

-- Immutability enforced by the database itself, not only by missing API routes.
CREATE OR REPLACE FUNCTION reject_mutation() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION '% rows are immutable', TG_TABLE_NAME USING ERRCODE = 'P0001';
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS transactions_immutable ON transactions;
CREATE TRIGGER transactions_immutable
  BEFORE UPDATE OR DELETE ON transactions
  FOR EACH ROW EXECUTE FUNCTION reject_mutation();

DROP TRIGGER IF EXISTS transfers_immutable ON transfers;
CREATE TRIGGER transfers_immutable
  BEFORE UPDATE OR DELETE ON transfers
  FOR EACH ROW EXECUTE FUNCTION reject_mutation();
