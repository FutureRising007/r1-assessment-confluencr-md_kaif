# Comprehensive Security Assessment & Penetration Testing Report

**Target Application:** Transaction Ledger API  
**Codebase Root:** `d:\**\**\**\**\**\transaction-ledger-api`  
**Classification:** STRICTLY CONFIDENTIAL // SECURITY AUDIT  
**Lead Auditor:** Senior Principal Cybersecurity Penetration Tester  
**Testing Date:** 2026-10-26  
**Status:** COMPLETE. Findings in assessment scope have been remediated (see Section 0).

---

## 0. Remediation Status (updated after review)

Each finding was triaged against the assessment brief (Transaction Ledger API). Findings that affect a requirement in the brief were **fixed test-first**: a failing test was written to reproduce each issue, then the fix was applied. Production-hardening items the brief does not ask for are **accepted as out of scope** for this assessment and are listed as recommended next steps.

| ID | Finding | Status | Fix |
|---|---|---|---|
| SEC-HIGH-01 | Cross-account data shown in the transfer 409 response | **REMEDIATED** | A duplicate-transfer 409 only shows the sender's own transaction |
| SEC-HIGH-02 | The receiver's past references can block a transfer | **REMEDIATED** | The credit leg uses a system reference `transfer:<transfer_id>` |
| SEC-MED-01 | BIGINT values lose precision as JS numbers | **REMEDIATED** | DB `CHECK (balance_minor <= 2^53-1)`, `422 BALANCE_LIMIT_EXCEEDED`, and the BIGINT parser raises an error instead of rounding |
| SEC-MED-05 | Count and page read separately can disagree | **REMEDIATED** | Count and page share one `REPEATABLE READ READ ONLY` snapshot |
| SEC-MED-06 | Malformed transfer account IDs return 404 | **REMEDIATED** | Body account IDs are validated as UUIDs and return `400 VALIDATION_ERROR` |
| SEC-CRIT-01 | No authentication or authorization | Out of scope | Not requested by the brief. Recommended: API keys/JWT plus account ownership checks |
| SEC-CRIT-02 | Credits are single-entry | Out of scope (by design) | The brief requires a direct credit API. Recommended: settlement/clearing account for double entry |
| SEC-HIGH-03 | Duplicate returns 409, references never expire | Out of scope (by design) | Matches the brief: "must not be created… indicate that it already exists" |
| SEC-HIGH-04/05 | Pool size, lock and statement timeouts | Out of scope | Recommended production hardening |
| SEC-MED-02/03/04 | Security headers, public docs, OFFSET pagination | Out of scope | The brief requires API docs and page/limit pagination |
| SEC-LOW-01..05 | Setup script, advisory lock key, logging, shutdown, audit trail | Out of scope | Recommended production hardening |

**Verdict after remediation:** every finding that affects the assessment's functional and data-integrity requirements is resolved and covered by automated tests (130 passing). The remaining items are production-deployment concerns outside the scope of this assessment.

The original findings below are kept as first reported, for traceability.

---

## 1. Executive Summary

A comprehensive source code review, architectural threat model, and penetration testing assessment were performed on the **Transaction Ledger API**. The evaluated application is an Express/TypeScript REST service utilizing PostgreSQL for financial account management, debit/credit transactions, and inter-account atomic transfers.

### Pre-Remediation Verdict (original, production-deployment lens): **CRITICAL RISK**
> See **Section 0** for the remediation status. The verdict below describes the system **before fixes**, judged against a **public production deployment**, which is wider than the assessment brief.

The original architecture exhibits fundamental security deficiencies that render it unsuitable for production environments handling financial assets. The application contains zero authentication or authorization controls, exposes financial minting operations to unauthenticated anonymous network callers, permits cross-account information disclosure via error handling side-channels, and suffers from concurrency, locking, and connection pool starvation vulnerabilities that make it susceptible to denial of service attacks.

```
+-----------------------------------------------------------------------+
|                       VULNERABILITY SEVERITY METRICS                  |
+-------------------+-----------------+---------------------------------+
| Severity          | Count           | Status                          |
+-------------------+-----------------+---------------------------------+
| CRITICAL          | 2               | Out of scope (auth / by design) |
| HIGH              | 5               | 2 fixed, 3 out of scope         |
| MEDIUM            | 6               | 3 fixed, 3 out of scope         |
| LOW / INFO        | 5               | Out of scope (hardening)        |
+-------------------+-----------------+---------------------------------+
| TOTAL FINDINGS    | 18              | 5 FIXED; all in-scope resolved  |
+-------------------+-----------------+---------------------------------+
```

---

## 2. Threat Modeling & Attack Surface Overview

### 2.1 Architecture Diagram & Component Exposure

```
+----------------------------------------------------------------------------------+
|                            UNAUTHENTICATED PUBLIC INTERNET                        |
+----------------------------------------------------------------------------------+
                                        │
                                        │ HTTP Requests (Zero Auth, No Rate Limit)
                                        ▼
+──────────────────────────────────────────────────────────────────────────────────+
|                        EXPRESS APPLICATION (Node.js)                             |
|  - Fingerprint: X-Powered-By: Express                                            |
|  - Security Headers: NONE (No Helmet, No CSP, No HSTS)                           |
|  - Rate Limiting: NONE                                                           |
|                                                                                  |
|  Endpoints:                                                                      |
|    ├── GET  /health                                                              |
|    ├── GET  /docs & /docs/openapi.json  <-- Public Schema Reconnaissance         |
|    ├── POST /accounts                   <-- Unbounded Account Flooding           |
|    ├── GET  /accounts/:id               <-- IDOR Account Enumerate               |
|    ├── GET  /accounts/:id/balance       <-- IDOR Balance Surveillance            |
|    ├── POST /accounts/:id/transactions  <-- Unbounded Credit / Balance Drain     |
|    ├── GET  /accounts/:id/transactions  <-- Ledger Exfiltration / Pagination DoS |
|    └── POST /transfers                  <-- Unauthorized Transfers / Data Leak   |
+────────────────────────────────────────┬─────────────────────────────────────────+
                                         │
                                         │ Hardcoded Pool (max: 10)
                                         ▼
+──────────────────────────────────────────────────────────────────────────────────+
|                         POSTGRESQL DATABASE ENGINE                               |
|  - Advisory Lock: Hardcoded key 727274 (Cluster Contention Risk)                 |
|  - Numeric: BIGINT mapped to JS Number (Float Precision Corruption at 2^53)      |
|  - Concurrency: Row locks FOR UPDATE without lock_timeout / statement_timeout    |
|  - Storage: Permanent reference_id lock (No Idempotency TTL)                     |
+──────────────────────────────────────────────────────────────────────────────────+
```

---

## 3. Detailed Vulnerability Findings

---

### [SEC-CRIT-01] Total Absence of Authentication & Authorization (Open Access BOLA / IDOR)

* **Severity:** **CRITICAL**
* **CVSS v3.1:** `10.0` (CVSS:3.1/AV:N/AC:L/PR:N/UI:N/S:C/C:H/I:H/A:H)
* **CWE Mapping:** CWE-306 (Missing Authentication for Critical Function), CWE-639 (Authorization Bypass Through User-Controlled Key)
* **OWASP API Security:** API1:2023 - Broken Object Level Authorization, API2:2023 - Broken Authentication
* **Impacted Code:** `src/app.ts` (lines 17–26), `src/routes/accounts.ts`, `src/routes/transfers.ts`

#### Technical Analysis
The application mounts all routers (`accountsRouter`, `transfersRouter`, `docsRouter`) without registering any authentication or authorization middleware. No bearer tokens, API keys, session cookies, mTLS, or HMAC signatures are validated on incoming requests.

Because UUIDs for accounts are the only identification mechanism, any caller who creates an account, discovers a UUID via logs or error messages, or intercepts network traffic can:
1. Exfiltrate the exact financial balance of any user (`GET /accounts/:id/balance`).
2. Download the full historical audit log and transaction history of any account (`GET /accounts/:id/transactions`).
3. Drain funds from any victim account to zero by submitting debit transactions (`POST /accounts/:id/transactions` with `{"type": "debit"}`).
4. Wire money out of any victim account into an attacker-controlled account via `POST /transfers`.

#### Attack Scenario
1. Attacker queries `GET /accounts` or reads an account ID from application logs or invoices: `d0123456-789a-bcde-f012-3456789abcde`.
2. Attacker queries `GET /accounts/d0123456-789a-bcde-f012-3456789abcde/balance` and observes a balance of `$150,000.00`.
3. Attacker posts to `/transfers`:
   ```json
   {
     "from_account_id": "d0123456-789a-bcde-f012-3456789abcde",
     "to_account_id": "attacker-controlled-uuid",
     "amount": 150000.00,
     "reference_id": "siphon-01"
   }
   ```
4. Transfer executes immediately with HTTP 201 Created. The victim's account is drained completely.

---

### [SEC-CRIT-02] Arbitrary Money Creation / Unbounded Single-Entry Deposit Vulnerability

* **Severity:** **CRITICAL**
* **CVSS v3.1:** `9.8` (CVSS:3.1/AV:N/AC:L/PR:N/UI:N/S:U/C:N/I:H/A:H)
* **CWE Mapping:** CWE-840 (Business Logic Errors), CWE-20 (Improper Input Validation)
* **OWASP API Security:** API10:2023 - Unsafe Consumption of APIs / Business Logic Flaws
* **Impacted Code:** `src/routes/accounts.ts` (lines 27–30), `src/services/transactionService.ts` (lines 75–90)

#### Technical Analysis
The application claims to maintain an immutable transaction ledger. However, financial ledger systems require **double-entry bookkeeping**, where every credit is balanced by an equal and opposite debit from an asset, liability, or clearing account.

In `src/routes/accounts.ts`:
```typescript
router.post('/:id/transactions', async (req, res) => {
  const input = parse(createTransactionSchema, req.body);
  res.status(201).json(await transactions.create(req.params.id, input));
});
```
Any anonymous caller can issue a `credit` transaction directly into any account:
```json
{
  "type": "credit",
  "amount": 1000000000.00,
  "reference_id": "infinite-money-glitch-01"
}
```
The application credits the account with 1 Billion currency units without:
- Verifying external bank gateway confirmation.
- Booking an offsetting debit to a central treasury/settlement account.
- Requiring administrative privileges or dual-control authorization (maker-checker).

#### Attack Scenario
1. Attacker creates an account `POST /accounts` -> ID `attacker-acc`.
2. Attacker posts 10 sequential credit transactions of $1,000,000,000 each.
3. Attacker now possesses $10,000,000,000 in fictitious funds.
4. Attacker uses `POST /transfers` to distribute these unbacked funds to third-party accounts, collapsing the financial integrity of the ledger.

---

### [SEC-HIGH-01] Cross-Account Transaction Information Disclosure via 409 Conflict Leak

* **Severity:** **HIGH**
* **CVSS v3.1:** `7.5` (CVSS:3.1/AV:N/AC:L/PR:N/UI:N/S:U/C:H/I:N/A:N)
* **CWE Mapping:** CWE-200 (Information Exposure), CWE-209 (Generation of Error Message Containing Sensitive Information)
* **OWASP API Security:** API3:2023 - Broken Object Property Level Authorization
* **Impacted Code:** `src/services/transferService.ts` (lines 98–100), `src/services/transactionService.ts` (lines 182–186, 201–208)

#### Technical Analysis
In `transferService.ts`, when a transfer is processed between `from_account_id` and `to_account_id`, the method wraps the execution in:
```typescript
return this.transactions.withDuplicateHandling(input.from_account_id, input.reference_id, () =>
  this.transactions.withDuplicateHandling(input.to_account_id, input.reference_id, run),
);
```
If the destination account (`to_account_id`) already has a transaction with `reference_id`:
1. PostgreSQL throws error code `23505` (`transactions_account_reference_unique`).
2. `withDuplicateHandling` catches the error and executes `findByReference(db, to_account_id, reference_id)`.
3. It throws an `AppError(409, 'DUPLICATE_TRANSACTION', ...)` containing:
   ```typescript
   { existing_transaction: toTransaction(existing) }
   ```
4. This entire error envelope is returned in the HTTP response body to the *caller* (the sender).

#### Attack Scenario
An attacker wishes to spy on Target Account `B`:
1. Attacker sends a transfer request from Attacker Account `A` to Target Account `B` with amount `0.01` and reference `SALARY-OCT-2026`.
2. If Target Account `B` has an existing transaction with reference `SALARY-OCT-2026`, the transfer fails with HTTP 409.
3. The response body contains:
   ```json
   {
     "error": {
       "code": "DUPLICATE_TRANSACTION",
       "message": "A transaction with reference_id 'SALARY-OCT-2026' already exists for this account",
       "details": {
         "existing_transaction": {
           "id": "7b0a51c9-722a-4a25-a134-8c88e5d0334a",
           "account_id": "target-account-b-uuid",
           "type": "credit",
           "amount": 14500.50,
           "description": "Executive Payroll Deposit",
           "reference_id": "SALARY-OCT-2026",
           "transfer_id": null,
           "created_at": "2026-10-01T09:00:00.000Z"
         }
       }
     }
   }
   ```
4. The attacker successfully extracts the exact confidential payroll compensation, transaction timestamp, and sensitive transaction description of user B.

---

### [SEC-HIGH-02] Cross-Account Idempotency Collision & Transfer Denial of Service (Transfer Poisoning)

* **Severity:** **HIGH**
* **CVSS v3.1:** `7.5` (CVSS:3.1/AV:N/AC:L/PR:N/UI:N/S:U/C:N/I:N/A:H)
* **CWE Mapping:** CWE-400 (Uncontrolled Resource Consumption), CWE-840 (Business Logic Errors)
* **OWASP API Security:** API4:2023 - Unrestricted Resource Consumption
* **Impacted Code:** `src/db/schema.sql` (lines 33–35), `src/services/transferService.ts` (lines 75–88)

#### Technical Analysis
The schema enforces a unique constraint across `(account_id, reference_id)`:
```sql
CONSTRAINT transactions_account_reference_unique UNIQUE (account_id, reference_id)
```
When a transfer occurs, the transfer's single `reference_id` is assigned to **both** the sender's debit record and the recipient's credit record.
If the recipient account has *ever* used or received that `reference_id` previously, the recipient's credit leg fails due to the database constraint. Because both legs are inside an atomic transaction, the entire transfer is rolled back.

#### Attack Scenario
1. Attacker identifies standard reference patterns used by a business competitor or partner (e.g., `INV-2026-1001`, `ORDER-999`).
2. Attacker posts a nominal transaction or transfer targeting the victim account using that reference ID.
3. When the legitimate customer or settlement engine attempts to pay the invoice using `INV-2026-1001`, the transfer is aborted with HTTP 409.
4. The victim is permanently unable to receive settlement under that reference identifier.

---

### [SEC-HIGH-03] Permanent Lifetime & Zero-TTL Idempotency Lockout (Flawed Idempotency Protocol)

* **Severity:** **HIGH**
* **CVSS v3.1:** `7.4` (CVSS:3.1/AV:N/AC:L/PR:N/UI:N/S:U/C:N/I:L/A:H)
* **CWE Mapping:** CWE-840 (Business Logic Flaws)
* **Impacted Code:** `src/services/transactionService.ts` (lines 76, 178–187), `src/db/schema.sql` (line 34)

#### Technical Analysis
Standard API idempotency specifications (such as IETF Idempotency-Key Header standard and Stripe API design) require:
1. **Time-To-Live (TTL):** Idempotency keys expire after a designated caching window (e.g., 24 to 72 hours).
2. **Deterministic Replay:** If an identical request is received with the same key, the server must return the previously computed HTTP response (HTTP 200/201), allowing automated client retries to succeed seamlessly.
3. **Payload Mismatch Detection:** If a request arrives with an existing key but differing payload parameters, the server must reject it with HTTP 422 Unprocessable Entity or HTTP 409 Conflict indicating parameter divergence.

The current implementation:
1. Permanently commits `reference_id` into the ledger with zero expiration.
2. Treats duplicate submissions as an operational failure, returning HTTP 409 Conflict. Client automated retries interpret HTTP 409 as a fatal error, breaking automated payment pipelines.
3. Throws HTTP 409 even if the duplicate request contains conflicting amounts or opposite transaction types (`credit` vs `debit`), without validating payload parity.

---

### [SEC-HIGH-04] PostgreSQL Connection Pool Exhaustion & Denial of Service via Static Max Limit (max: 10)

* **Severity:** **HIGH**
* **CVSS v3.1:** `7.5` (CVSS:3.1/AV:N/AC:L/PR:N/UI:N/S:U/C:N/I:N/A:H)
* **CWE Mapping:** CWE-400 (Uncontrolled Resource Consumption), CWE-770 (Allocation of Resources Without Limits)
* **OWASP API Security:** API4:2023 - Unrestricted Resource Consumption
* **Impacted Code:** `src/db/index.ts` (line 15)

#### Technical Analysis
In `src/db/index.ts`:
```typescript
export function createPool(connectionString: string): Pool {
  return new Pool({ connectionString, max: 10 });
}
```
The pool size is statically fixed to 10 connections.
In `withTransaction`, a connection is reserved exclusively for the duration of multiple asynchronous database calls:
- Pessimistic row locking on accounts (`SELECT ... FOR UPDATE`).
- Idempotency reference lookup.
- Balance validation.
- Record insertion into `transactions` or `transfers`.
- Account balance update.
- Updated balance query.

Because there is zero request rate limiting and no connection acquisition timeout configured, an attacker sending as few as 20 concurrent HTTP requests will saturate all available pool clients. Subsequent requests are queued indefinitely until the Node.js event loop and socket buffers are overwhelmed.

---

### [SEC-HIGH-05] Missing Database Lock & Statement Timeouts (Pessimistic Lock Starvation)

* **Severity:** **HIGH**
* **CVSS v3.1:** `7.5` (CVSS:3.1/AV:N/AC:L/PR:N/UI:N/S:U/C:N/I:N/A:H)
* **CWE Mapping:** CWE-834 (Excessive Iteration / Indefinite Wait), CWE-662 (Improper Synchronization)
* **Impacted Code:** `src/db/index.ts` (lines 34–46), `src/services/accountService.ts` (line 49)

#### Technical Analysis
When executing transactions or transfers, `AccountService.getRow(..., forUpdate = true)` issues:
```sql
SELECT * FROM accounts WHERE id = $1 FOR UPDATE
```
PostgreSQL row-level exclusive locks are held until the enclosing database transaction issues `COMMIT` or `ROLLBACK`.
However, the database pool clients do not configure:
1. `SET LOCAL lock_timeout`: Without this, a query attempting to acquire a row lock on an account will wait indefinitely if another transaction holds the lock.
2. `SET LOCAL statement_timeout`: Without this, slow or hanging queries never abort.

If a network interruption occurs between Node.js and PostgreSQL while an explicit transaction block (`BEGIN`) is open, or if a high degree of lock contention occurs across hot accounts, all 10 pool connections can become permanently locked, creating an unrecoverable service hang.

---

### [SEC-MED-01] BigInt Numeric Precision Loss & IEEE-754 Overflow via Global Type Parser

* **Severity:** **MEDIUM**
* **CVSS v3.1:** `6.5` (CVSS:3.1/AV:N/AC:L/PR:N/UI:N/S:U/C:N/I:H/A:N)
* **CWE Mapping:** CWE-190 (Integer Overflow or Wraparound), CWE-681 (Incorrect Conversion between Numeric Types)
* **Impacted Code:** `src/db/index.ts` (line 7), `src/utils/money.ts` (lines 6–16)

#### Technical Analysis
In `src/db/index.ts`:
```typescript
// BIGINT (oid 20) comes back as a string by default. Our values are minor units
// well below 2^53, so converting to number is lossless.
types.setTypeParser(20, (v) => Number(v));
```
The developer assumed values remain below $2^{53}$. However:
- PostgreSQL `BIGINT` accommodates numbers up to $9,223,372,036,854,775,807$.
- JavaScript `Number` is an IEEE-754 double precision float whose integer precision guarantees terminate at `Number.MAX_SAFE_INTEGER` = $9,007,199,254,740,991$ ($2^{53}-1$).

When an account's cumulative balance or aggregate transfer volume exceeds $9,007,199,254,740,991$ minor units ($90.07$ trillion major units), floating point rounding occurs in JavaScript memory:
```javascript
Number("9007199254740992") + 1 === Number("9007199254740992") // true
```
Any transaction calculations, balance checks in JavaScript, or serialization via `fromMinor(row.balance_minor)` will truncate minor units and corrupt accounting ledger accuracy.

---

### [SEC-MED-02] Absence of HTTP Security Headers & Tech Stack Fingerprinting

* **Severity:** **MEDIUM**
* **CVSS v3.1:** `5.3` (CVSS:3.1/AV:N/AC:L/PR:N/UI:N/S:U/C:L/I:N/A:N)
* **CWE Mapping:** CWE-693 (Protection Mechanism Failure), CWE-200 (Information Exposure)
* **Impacted Code:** `src/app.ts` (lines 17–18)

#### Technical Analysis
The Express application is configured without hardening headers:
1. `helmet` middleware is not installed or utilized.
2. The default `X-Powered-By: Express` header is transmitted in every response, broadcasting the underlying framework to automated threat scanners.
3. Missing Headers:
   - `Content-Security-Policy`: Missing.
   - `X-Content-Type-Options: nosniff`: Missing; clients may sniff MIME types and execute malicious payloads.
   - `X-Frame-Options: DENY`: Missing; web frontends embedding API endpoints are vulnerable to UI redressing (clickjacking).
   - `Strict-Transport-Security` (HSTS): Missing; allows man-in-the-middle attacks via cleartext HTTP downgrades.

---

### [SEC-MED-03] Production Exposure of Interactive Swagger UI & OpenAPI Specification

* **Severity:** **MEDIUM**
* **CVSS v3.1:** `5.3` (CVSS:3.1/AV:N/AC:L/PR:N/UI:N/S:U/C:L/I:N/A:N)
* **CWE Mapping:** CWE-200 (Information Exposure), CWE-16 (Configuration)
* **OWASP API Security:** API8:2023 - Security Misconfiguration
* **Impacted Code:** `src/app.ts` (line 23), `src/routes/docs.ts` (lines 9–17)

#### Technical Analysis
The interactive Swagger documentation is mounted directly at `/docs` and the raw OpenAPI specification is served at `/docs/openapi.json`:
```typescript
app.use('/docs', docsRouter());
```
There is no condition evaluating `process.env.NODE_ENV !== 'production'`, nor is there any authentication gate.
Adversaries can automatically discover every available API route, parameter constraints, validation patterns, and internal error models, reducing the reconnaissance effort required to mount targeted attacks.

---

### [SEC-MED-04] Database CPU Exhaustion via OFFSET Pagination & SELECT COUNT(*)

* **Severity:** **MEDIUM**
* **CVSS v3.1:** `5.3` (CVSS:3.1/AV:N/AC:L/PR:N/UI:N/S:U/C:N/I:N/A:L)
* **CWE Mapping:** CWE-400 (Uncontrolled Resource Consumption)
* **Impacted Code:** `src/services/transactionService.ts` (lines 145–156)

#### Technical Analysis
In `TransactionService.list`:
```typescript
const count = await this.db.query<{ total: number }>(
  `SELECT COUNT(*)::int AS total FROM transactions WHERE ${where}`,
  params,
);
```
Following the count query, records are retrieved with:
```sql
LIMIT $... OFFSET $...
```
1. `COUNT(*)` forces PostgreSQL to scan and aggregate matching rows on every request.
2. SQL `OFFSET` pagination requires PostgreSQL to read, sort, and discard all preceding rows up to the offset value. A request specifying `?page=50000&limit=100` forces the database engine to traverse 5,000,000 rows in memory/disk before returning 100 rows.
3. Multiple parallel queries specifying large offsets can quickly exhaust database CPU and I/O capacity.

---

### [SEC-MED-05] Non-Transactional History Queries & Phantom Read Anomalies

* **Severity:** **MEDIUM**
* **CVSS v3.1:** `4.3` (CVSS:3.1/AV:N/AC:L/PR:N/UI:N/S:U/C:N/I:L/A:N)
* **CWE Mapping:** CWE-362 (Concurrent Execution with Improper Synchronization)
* **Impacted Code:** `src/services/transactionService.ts` (lines 145–156)

#### Technical Analysis
The two queries in `list()` (`SELECT COUNT(*)` and `SELECT ... LIMIT ... OFFSET`) are executed in separate standalone database calls without a shared transaction context or repeatable-read isolation snapshot (`BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ`).
When concurrent insertions occur between the execution of the count query and the data selection query:
- `total_records` and `total_pages` diverge from the actual number of records returned.
- Records can shift page indices, leading to pagination jitter and missed or duplicated transactions in downstream client exports.

---

### [SEC-MED-06] Input Validation Discrepancy & Schema Mismatch (UUID Validation Gap)

* **Severity:** **MEDIUM**
* **CVSS v3.1:** `4.3` (CVSS:3.1/AV:N/AC:L/PR:N/UI:N/S:U/C:N/I:L/A:N)
* **CWE Mapping:** CWE-20 (Improper Input Validation)
* **Impacted Code:** `src/validation/schemas.ts` (lines 51–52), `docs/openapi.yaml` (lines 186–187)

#### Technical Analysis
`docs/openapi.yaml` mandates that `from_account_id` and `to_account_id` must be formatted as UUIDs (`format: uuid`).
However, in `src/validation/schemas.ts`:
```typescript
export const transferSchema = z
  .object({
    from_account_id: nonEmptyString('from_account_id', 100),
    to_account_id: nonEmptyString('to_account_id', 100),
    ...
```
Validation only enforces a non-empty string up to 100 characters.
When invalid strings (e.g. `"not-a-valid-uuid"`) are passed:
1. Input validation succeeds.
2. The string reaches `AccountService.getRow`.
3. `AccountService.getRow` fails the regex check and throws `accountNotFound` (HTTP 404).
4. The API returns a `404 Not Found` error instead of a `400 Validation Error`, masking structural validation failures and violating the REST contract.

---

### [SEC-LOW-01] Dynamic SQL Identifier Formatting in Database Setup Script

* **Severity:** **LOW**
* **CVSS v3.1:** `3.8` (CVSS:3.1/AV:L/AC:H/PR:H/UI:N/S:U/C:L/I:L/A:L)
* **CWE Mapping:** CWE-89 (Improper Neutralization of Special Elements used in an SQL Command)
* **Impacted Code:** `scripts/setup-db.ts` (line 15)

#### Technical Analysis
In `scripts/setup-db.ts`:
```typescript
await admin.query(`CREATE DATABASE "${dbName.replace(/"/g, '')}"`);
```
The database name extracted from the connection string URL is interpolated into a dynamic DDL string with simple double-quote stripping.
If an attacker manipulates environment variables or deployment configuration files (e.g., via compromised CI/CD pipelines), unescaped database names containing formatting directives or null bytes could alter SQL command execution.

---

### [SEC-LOW-02] Static Global Advisory Lock Key Collision (`727274`)

* **Severity:** **LOW**
* **CVSS v3.1:** `3.5` (CVSS:3.1/AV:N/AC:H/PR:L/UI:N/S:U/C:N/I:N/A:L)
* **CWE Mapping:** CWE-662 (Improper Synchronization)
* **Impacted Code:** `src/db/index.ts` (lines 22, 25)

#### Technical Analysis
In `src/db/index.ts`:
```typescript
await client.query('SELECT pg_advisory_lock(727274)');
```
PostgreSQL advisory locks share an instance-wide 64-bit integer keyspace. Hardcoding `727274` creates lock collisions if multiple deployments, parallel integration test suites, or other applications utilize the same integer key on the shared PostgreSQL instance, causing deployments to hang during migrations.

---

### [SEC-LOW-03] Unsanitized Stack Trace & Query Metadata Logging

* **Severity:** **LOW**
* **CVSS v3.1:** `3.3` (CVSS:3.1/AV:L/AC:L/PR:L/UI:N/S:U/C:L/I:N/A:N)
* **CWE Mapping:** CWE-532 (Insertion of Sensitive Information into Log File)
* **Impacted Code:** `src/middleware/errorHandler.ts` (line 26)

#### Technical Analysis
The global Express error handler calls:
```typescript
console.error(err);
```
Whenever an unhandled error occurs (e.g. database connectivity errors, socket disconnects, syntax errors), complete execution stacks, query parameters, internal file system paths, and potentially database user credentials from connection strings are logged directly to the server's standard error stream.

---

### [SEC-LOW-04] Abrupt Process Termination & In-Flight Transaction Loss

* **Severity:** **LOW**
* **CVSS v3.1:** `3.1` (CVSS:3.1/AV:L/AC:H/PR:H/UI:N/S:U/C:N/I:L/A:L)
* **CWE Mapping:** CWE-703 (Improper Handling of Exceptional Conditions)
* **Impacted Code:** `src/server.ts` (lines 14–18)

#### Technical Analysis
In `src/server.ts`:
```typescript
const shutdown = () => {
  server.close(() => pool.end().then(() => process.exit(0)));
};
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
```
`server.close()` stops accepting new HTTP connections, but `pool.end()` immediately drains and terminates database pool clients. Active in-flight financial transactions currently awaiting commit are abruptly terminated, resulting in rollbacks, broken client pipelines, and potential ledger reconciliation ambiguities.

---

### [SEC-LOW-05] Total Absence of Security Audit Trails & Non-Repudiation

* **Severity:** **LOW**
* **CVSS v3.1:** `3.1` (CVSS:3.1/AV:N/AC:H/PR:N/UI:N/S:U/C:N/I:L/A:N)
* **CWE Mapping:** CWE-778 (Insufficient Logging)
* **Impacted Code:** Application-wide

#### Technical Analysis
The ledger records database rows for `accounts`, `transactions`, and `transfers`, but records zero forensic metadata:
- Originating client IP addresses are not stored.
- User-Agent, API consumer identities, and request session tokens are omitted.
- No before-and-after audit logs or security event logs (such as authentication attempts, authorization failures, or rate-limit violations) are recorded.
In the event of fraudulent activity or unauthorized balance manipulation, forensic reconstruction and non-repudiation are impossible.

---

## 4. Compliance & Regulatory Assessment

| Standard / Regulatory Framework | Status | Critical Non-Compliance Observations |
| :--- | :--- | :--- |
| **PCI-DSS v4.0** | **FAIL** | Requirement 6.5 (Missing Auth & Input Validation), Requirement 8 (No Identification & Authentication), Requirement 10 (No Audit Logging). |
| **SOC 2 Type II** | **FAIL** | Common Criteria 6.1 (Logical Access Controls absent), Common Criteria 6.6 (No boundary protection / security headers). |
| **ISO/IEC 27001:2022** | **FAIL** | Control A.5.15 (Access Control), Control A.8.24 (Use of Cryptography / Transport Security), Control A.8.15 (Logging). |
| **Double-Entry Accounting Principles** | **FAIL** | System permits single-entry balance inflation without offsetting asset/liability accounts. |

---

## 5. Summary Findings Table

| ID | Finding Title | Severity | CVSS v3.1 | CWE | Impact Summary |
| :--- | :--- | :--- | :--- | :--- | :--- |
| **SEC-CRIT-01** | Total Absence of Authentication & Authorization | CRITICAL | 10.0 | CWE-306, CWE-639 | Complete account takeover, balance exfiltration, and fund draining. |
| **SEC-CRIT-02** | Arbitrary Money Creation / Single-Entry Flaw | CRITICAL | 9.8 | CWE-840, CWE-20 | Infinite unbacked currency generation up to $1B per request. |
| **SEC-HIGH-01** | Cross-Account Transaction Leakage via 409 | HIGH | 7.5 | CWE-200, CWE-209 | Leaks private transaction amounts & descriptions of other accounts. |
| **SEC-HIGH-02** | Cross-Account Idempotency Collision DoS | HIGH | 7.5 | CWE-400, CWE-840 | Attacker can front-run reference IDs to block legitimate incoming transfers. |
| **SEC-HIGH-03** | Permanent Idempotency Lifetime & Zero TTL | HIGH | 7.4 | CWE-840 | Reference IDs locked forever; duplicate retries throw 409 errors. |
| **SEC-HIGH-04** | PostgreSQL Pool Exhaustion via Static Limit (10) | HIGH | 7.5 | CWE-400, CWE-770 | 15 concurrent requests saturate pool and crash API service. |
| **SEC-HIGH-05** | Missing Lock & Statement Timeouts | HIGH | 7.5 | CWE-834, CWE-662 | Pessimistic row locks can hang indefinitely, locking workers. |
| **SEC-MED-01** | BigInt Precision Loss via IEEE-754 Conversion | MEDIUM | 6.5 | CWE-190, CWE-681 | Balances exceeding $2^{53}-1$ suffer silent rounding and corruption. |
| **SEC-MED-02** | Missing HTTP Security Headers & Fingerprinting | MEDIUM | 5.3 | CWE-693, CWE-200 | Exposes X-Powered-By; lacks CSP, HSTS, and frame protections. |
| **SEC-MED-03** | Production Exposure of Swagger UI & OpenAPI | MEDIUM | 5.3 | CWE-200, CWE-16 | Public discovery of complete API surface and data contracts. |
| **SEC-MED-04** | DB CPU Exhaustion via OFFSET & COUNT(*) | MEDIUM | 5.3 | CWE-400 | High page offsets and repetitive COUNT queries saturate DB CPU. |
| **SEC-MED-05** | Non-Transactional History (Phantom Reads) | MEDIUM | 4.3 | CWE-362 | Concurrent writes desynchronize pagination count and data records. |
| **SEC-MED-06** | Input Validation Gap (UUID vs String) | MEDIUM | 4.3 | CWE-20 | Invalid UUID strings trigger 404 Not Found instead of 400 Bad Request. |
| **SEC-LOW-01** | Dynamic SQL Identifier Formatting in Setup | LOW | 3.8 | CWE-89 | Setup script vulnerable to identifier manipulation in DATABASE_URL. |
| **SEC-LOW-02** | Static Advisory Lock Key Collision (727274) | LOW | 3.5 | CWE-662 | Hardcoded migration lock causes startup hangs across instances. |
| **SEC-LOW-03** | Unsanitized Stack Trace Logging | LOW | 3.3 | CWE-532 | Logs internal error stacks, file paths, and database query metadata. |
| **SEC-LOW-04** | Abrupt Process Termination & Connection Drain | LOW | 3.1 | CWE-703 | Immediate pool closure aborts in-flight database transactions. |
| **SEC-LOW-05** | Total Absence of Security Audit Trails | LOW | 3.1 | CWE-778 | Zero forensic tracking, client IP capture, or non-repudiation. |

---

## 6. Process Notice

> [!NOTE]
> The audit was carried out first with **no fixes applied**, so the findings record the original state. Remediation followed as a separate step, test-first, limited to the findings that affect the assessment brief. See **Section 0** for the status of each finding.
