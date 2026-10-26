# Transaction Ledger API

A backend API for a simple transaction ledger. You can create accounts, post credit and debit transactions, read balances and paginated history, and transfer money between accounts atomically.

**Stack:** Node.js 18+ · TypeScript · Express 5 · PostgreSQL · Zod · Jest + Supertest · OpenAPI / Swagger UI

---

## Table of contents
1. [How this was built: TDD with unit and integration tests](#1-how-this-was-built-tdd-with-unit-and-integration-tests)
2. [Quick start](#2-quick-start)
3. [API overview](#3-api-overview)
4. [How data integrity is guaranteed](#4-how-data-integrity-is-guaranteed)
5. [Error handling](#5-error-handling)
6. [Project structure](#6-project-structure)
7. [Assumptions and design decisions](#7-assumptions-and-design-decisions)

---

## 1. How this was built: TDD with unit and integration tests

This project was built **test-first**. Every feature went through the same **Red, Green, Refactor** loop:

```
 ┌──────────┐     ┌──────────┐     ┌────────────┐
 │   RED    │ ──▶ │  GREEN   │ ──▶ │  REFACTOR  │ ──┐
 │ write a  │     │ write the│     │ clean up,  │   │
 │ failing  │     │ minimum  │     │ tests stay │   │
 │ test     │     │ code     │     │ green      │   │
 └──────────┘     └──────────┘     └────────────┘   │
       ▲─────────────────────────────────────────────┘
```

1. **Red:** turn a requirement from the brief into a test, run it, and watch it fail. For example: *"a debit larger than the balance must be rejected and the balance must stay at 100."*
2. **Green:** write the smallest implementation that makes the test pass.
3. **Refactor:** improve the structure while the test suite keeps it safe.

The features were built in this order, each starting with failing tests: money and validation, then accounts, then transactions (including duplicate handling and atomicity), then history and pagination, then transfers and concurrency. Each requirement in the brief maps to at least one named test, so **the test suite works as a checklist for the spec**.

### Two layers of tests

| Layer | Folder | What it covers | Database |
|---|---|---|---|
| **Unit** | `tests/unit/` | Pure logic: money conversion (no floating-point drift), every validation rule, how errors map to HTTP responses | None. Fast, runs anywhere |
| **Integration: services** | `tests/integration/services/` | Business rules against **real PostgreSQL**: atomic rollback, row locking under concurrency, database constraints, immutability triggers, transfers | Real Postgres (`ledger_test`) |
| **Integration: API** | `tests/integration/api/` | The full HTTP stack with Supertest: routes, status codes, the error format, request validation | Real Postgres (`ledger_test`) |

Integration tests **always run against a real PostgreSQL database**, never mocks. Most ledger bugs (lost updates, partial writes, race conditions, constraint violations) only show up with a real database. The test database is created automatically and emptied before each test, so tests are isolated and repeatable.

### Highlights from the test suite
- **Spec examples as tests:** 100 + 50 = 150; 100 − 30 = 70; a debit of 150 from 100 is rejected; +100 +50 −30 −20 = 100; transfer 30 from A=100 to B=50 gives A=70, B=80.
- **Concurrency:** 80 debits of 1 sent at once against a balance of 50 give **exactly 50 successes and a balance of 0**. Never negative.
- **Duplicate requests under a race:** 10 simultaneous requests with the same `reference_id` create **exactly one** transaction.
- **Atomicity:** a database fault is injected after the transaction insert. Both the insert and the balance change roll back.
- **No partial transfer:** the credit leg is made to fail after the debit leg ran. The source is not debited.
- **No deadlocks:** opposing A→B and B→A transfers run at the same time, and total money is conserved.
- **Transfers stay isolated per account:** a reference the receiver already used doesn't block a transfer, and a duplicate-transfer error shows only the sender's own transaction.
- **Consistent pagination:** a write committed between the count query and the page query is injected, and `total_records` still matches the rows returned.
- **Exact large balances:** balances can never pass 2^53 − 1 minor units, the largest whole number JavaScript stores exactly.
- **Immutability:** `UPDATE` and `DELETE` on transactions are rejected **by the database**, not only by the API.
- **Balance consistency:** the stored balance is checked against a balance recomputed from the ledger.

### Running the tests
```bash
npm test                  # everything (unit + integration)
npm run test:unit         # unit tests only (no database needed)
npm run test:integration  # integration tests (needs PostgreSQL running)
npm run test:coverage     # with coverage report
```

---

## 2. Quick start

### Prerequisites
- **Node.js 18+**
- **PostgreSQL 13+**, either installed locally or via Docker (`docker compose up -d` uses the included `docker-compose.yml`)

### Setup
```bash
npm install
cp .env.example .env        # change the credentials if your Postgres uses different ones
npm run db:setup            # creates the "ledger" database and applies the schema
npm run dev                 # starts on http://localhost:3000
```

Production-style run:
```bash
npm run build && npm start
```

- **Interactive API docs (Swagger UI):** http://localhost:3000/docs
- **OpenAPI spec:** [`docs/openapi.yaml`](docs/openapi.yaml), also served at `/docs/openapi.json`
- **Health check:** `GET /health`

The schema is idempotent and is also applied automatically when the server starts.

---

## 3. API overview

| Method | Endpoint | Description | Success |
|---|---|---|---|
| `POST` | `/accounts` | Create an account (balance always starts at 0) | `201` |
| `GET` | `/accounts/:id` | Get an account | `200` |
| `GET` | `/accounts/:id/balance` | Current balance: `{ account_id, balance }` | `200` |
| `POST` | `/accounts/:id/transactions` | Add a credit or debit | `201` |
| `GET` | `/accounts/:id/transactions?type=&page=&limit=` | History: latest first, filterable, paginated | `200` |
| `PUT/PATCH/DELETE` | `/accounts/:id/transactions/:txId` | Always rejected: transactions are immutable | `405` |
| `POST` | `/transfers` | **Bonus:** atomic transfer between accounts | `201` |

### Examples

```bash
# Create an account
curl -X POST localhost:3000/accounts -H "Content-Type: application/json" -d '{"name":"Alice"}'
# → 201 {"id":"6f1c…","name":"Alice","balance":0,"created_at":"2026-10-26T12:00:00.000Z"}

# Credit
curl -X POST localhost:3000/accounts/<id>/transactions -H "Content-Type: application/json" \
  -d '{"type":"credit","amount":100,"description":"Salary","reference_id":"order-1001"}'
# → 201 {"transaction":{…},"balance":100}

# Same request again: nothing changes
# → 409 {"error":{"code":"DUPLICATE_TRANSACTION","message":"…","details":{"existing_transaction":{…}}}}

# History: debits only, page 1, 5 per page
curl "localhost:3000/accounts/<id>/transactions?type=debit&page=1&limit=5"
# → 200 {"data":[…],"pagination":{"page":1,"limit":5,"total_records":12,"total_pages":3}}

# Transfer
curl -X POST localhost:3000/transfers -H "Content-Type: application/json" \
  -d '{"from_account_id":"<A>","to_account_id":"<B>","amount":30,"reference_id":"tr-1"}'
# → 201 {"transfer":{…},"debit":{…},"credit":{…},"balances":{"<A>":70,"<B>":80}}
```

Full request and response schemas are in Swagger UI at `/docs`.

---

## 4. How data integrity is guaranteed

Every integrity rule is enforced **in the application and again in the database**. A bug in one layer cannot corrupt the ledger.

| Requirement | Application layer | Database layer |
|---|---|---|
| **Atomicity** | Insert and balance update run inside one `BEGIN … COMMIT`. Any error triggers `ROLLBACK` | Postgres transactions |
| **No overdraft, even under concurrency** | `SELECT … FOR UPDATE` locks the account row, so concurrent writers to one account are serialised. The balance update is also guarded (`WHERE balance + delta >= 0`) | `CHECK (balance_minor >= 0)` |
| **Duplicate `reference_id`** | Checked under the row lock, returns `409` with the original transaction | `UNIQUE (account_id, reference_id)`. A race that slips past the check is still caught and mapped to `409` |
| **Immutability** | No update or delete routes exist; those methods return `405` | `BEFORE UPDATE OR DELETE` triggers raise an error on `transactions` and `transfers` |
| **Valid data** | Zod schemas validate every request | `CHECK (type IN ('credit','debit'))`, `CHECK (amount_minor > 0)`, `NOT NULL`, foreign keys |
| **Exact money** | Amounts are converted to integer minor units (`19.99` becomes `1999`). A credit that would push the balance past 2^53 − 1 is rejected (`422`), and BIGINT values outside that range raise an error instead of being rounded | `BIGINT` columns, no floating point, `CHECK (balance_minor <= 9007199254740991)` |
| **Consistent history pages** | The count query and the page query run in one `REPEATABLE READ READ ONLY` snapshot | Postgres MVCC snapshot |
| **Transfer deadlock-safety** | Both account rows are locked in sorted ID order | |

---

## 5. Error handling

Every error, including 404s for unknown routes and malformed JSON, uses **one envelope**:

```json
{
  "error": {
    "code": "INSUFFICIENT_BALANCE",
    "message": "Insufficient balance for this debit",
    "details": { "account_id": "…", "balance": 100, "requested_amount": 150 }
  }
}
```

| HTTP | `code` | When |
|---|---|---|
| 400 | `VALIDATION_ERROR` | Invalid body or field (missing name, bad type, amount ≤ 0, unknown fields such as `balance`, a transfer account ID that isn't a UUID). `details` lists each field |
| 400 | `INVALID_JSON` | Malformed JSON body |
| 400 | `INVALID_PAGINATION` | `page` or `limit` not a positive integer, or `limit` > 100 |
| 404 | `ACCOUNT_NOT_FOUND` | Unknown or malformed account ID |
| 404 | `NOT_FOUND` | Unknown route |
| 405 | `METHOD_NOT_ALLOWED` | Attempt to edit or delete a transaction |
| 409 | `DUPLICATE_TRANSACTION` | `reference_id` already used on this account. `details.existing_transaction` holds the original |
| 422 | `INSUFFICIENT_BALANCE` | Debit or transfer exceeds the balance |
| 422 | `BALANCE_LIMIT_EXCEEDED` | Credit would push the balance past the largest exactly-representable value |
| 500 | `INTERNAL_ERROR` | Unexpected error. Internals are logged on the server, never sent to the client |

---

## 6. Project structure

```
src/
  app.ts                  # Express app factory (database injected, so it's testable)
  server.ts               # Entry point: migrate, then listen, with graceful shutdown
  config.ts               # Environment config
  errors.ts               # AppError + error codes
  db/
    schema.sql            # Tables, constraints, indexes, immutability triggers
    index.ts              # Pool, migration, withTransaction() helper
  validation/schemas.ts   # Zod request schemas
  services/               # Business logic (no HTTP knowledge)
    accountService.ts
    transactionService.ts
    transferService.ts
  routes/                 # Thin HTTP layer: validate, call service, respond
  middleware/             # Error handler, validation helper
  utils/money.ts          # Major and minor unit conversion
tests/
  unit/                   # Pure logic tests
  integration/services/   # Service tests on real PostgreSQL
  integration/api/        # HTTP tests (Supertest) on real PostgreSQL
  setup/                  # Test database bootstrap and per-test reset
docs/openapi.yaml         # API documentation
scripts/setup-db.ts       # Creates the database and applies the schema
```

Layering: **routes** (HTTP) call **services** (business rules), which call **PostgreSQL** (constraints). Services take the database pool through the constructor, so tests can point them at the test database.

---

## 7. Assumptions and design decisions

1. **Money format:** amounts are decimal numbers in major units (e.g. rupees) with **at most 2 decimal places**, and must be greater than 0 and at most 1,000,000,000. They are stored as integer minor units to avoid floating-point errors. The API is single-currency.
2. **Duplicate `reference_id` returns `409 Conflict`,** and the response includes the **original transaction**. The brief asks for a response *"indicating that the transaction already exists"*, and 409 makes that explicit. A client that retries after a timeout can still read the original result from `details`. The repeated payload is not compared: the same reference always counts as a duplicate, even if the amount differs.
3. **Rejected transactions are not stored.** A debit refused for insufficient balance is not written to the ledger and **does not use up** its `reference_id`, so the client can retry it with the same reference once funds arrive.
4. **The client cannot set system fields.** Sending `balance`, `id` or `created_at` (or any unknown field) when creating an account returns `400`, rather than being silently ignored, so the client knows it was not applied.
5. **Account IDs are UUIDs** generated by the server. In the **request body** of a transfer, a malformed account ID is invalid request data and returns `400 VALIDATION_ERROR`. In a **URL path** (`/accounts/:id/...`), a malformed ID returns `404 ACCOUNT_NOT_FOUND`, because that resource cannot exist.
6. **`description` is optional** (max 255 characters). `name` is at most 100 characters and is trimmed.
7. **Pagination:** `page` defaults to 1 and `limit` defaults to 10 (maximum 100). A page past the end returns an empty `data` array with correct metadata, not an error.
8. **Ordering:** latest first by `created_at` (`clock_timestamp()`, so each row gets its own timestamp). A sequence column breaks ties deterministically.
9. **Transfers:** each transfer is stored in a `transfers` table and creates **two ordinary ledger entries** (a debit on the source and a credit on the destination) linked by `transfer_id`, so transfers appear in normal history. The caller's `reference_id` belongs to the **sender's** debit entry, which is what makes a transfer idempotent. The receiver's credit entry gets a system reference (`transfer:<transfer_id>`). Since `reference_id` is unique per account, the sender's reference must not collide with the receiver's own history. This way a reference the receiver already used can't block a transfer, and a duplicate-transfer `409` only shows the sender's own transaction. A transfer to the same account is rejected with `400`.
10. **Response shape:** the transaction and transfer endpoints also return the resulting balance or balances, to save the client an extra call.
11. **Out of scope:** authentication, multi-currency and account closure were not requested, so they are not implemented. Transactions cannot be undone; a correction would be a new opposite transaction, as in standard ledger practice.
12. **Immutability scope:** triggers block row-level `UPDATE` and `DELETE`. `TRUNCATE` is a privileged admin operation the API never performs, and the test suite uses it for resets.
13. **Maximum balance:** an account balance is capped at 2^53 − 1 minor units (about 90 trillion in major units), so every value stays exact in JavaScript. Credits beyond that return `422 BALANCE_LIMIT_EXCEEDED`.
14. **Security review scope:** a penetration test of this API is in [`security_testing/`](security_testing/). Findings that affect a requirement in the brief were fixed with tests first: transfer reference isolation, UUID validation, balance precision and pagination consistency. Production-hardening items outside the brief were deliberately left out of scope for this assessment: authentication and authorization, rate limiting, security headers, gating the docs, pool and lock timeouts, and audit logging.
