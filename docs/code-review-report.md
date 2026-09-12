# Meridian Helpdesk – Code Review Report

## 1. Executive Summary

This report presents the findings of a comprehensive security and architecture code review conducted on the **Meridian Helpdesk** starter repository. The application is a multi-tenant support desk system designed for customer organizations to raise tickets, support agents to triage and claim them, and users to exchange comments.

The review identified multiple critical and high-severity security vulnerabilities, authorization gaps, and business logic flaws across authentication, multi-tenant boundaries, ticket lifecycle management, and SQL query construction. Ten total findings were documented, from which the top five highest-impact security findings were selected for immediate remediation in Part 1.

---

## 2. Review Scope

The scope of this code review encompasses the entire backend codebase and database architecture:
- **Server Routes**: `server/src/routes/auth.js`, `server/src/routes/tickets.js`, `server/src/routes/comments.js`
- **Middleware & Security Guards**: `server/src/middleware/auth.js`
- **Services & Data Access**: `server/src/services/ticketService.js`
- **Database Layer & Configuration**: `server/src/db/pool.js`, `server/src/config.js`, `db/schema.sql`
- **Database Scripts**: `server/scripts/reset-db.js`, `server/scripts/setup-db-user.js`

---

## 3. Review Methodology

1. **Static Source Code Analysis**: Manual line-by-line inspection of all route handlers, database query builders, authentication mechanisms, and role guards.
2. **Request Flow & Boundary Tracing**: Tracing request parameters from HTTP ingestion down to SQL execution to identify missing authorization checks, parameter pollution, and cross-tenant leakage.
3. **Multi-Tenant Boundary Verification**: Validating that every data retrieval, update, assignment, and deletion operation strictly enforces organization boundaries (`org_id`).
4. **Role Permission Matrix Auditing**: Comparing the implemented route guards against the documented RBAC permissions (`requester`, `agent`, `admin`).

---

## 4. Severity Classification

- **Critical**: Vulnerabilities allowing arbitrary account takeover, full database exposure/modification, or complete breach of tenant isolation without authentication.
- **High**: Vulnerabilities enabling unauthorized data disclosure, privilege escalation, cross-tenant modification, or complete bypass of intended role boundaries.
- **Medium**: Flaws allowing minor unauthorized actions, concurrency race conditions, or unvalidated inputs causing 500 errors.
- **Low**: Minor logic bugs, performance inefficiencies, or information leaks with minimal business impact.

---

## 5. Findings Summary

| Finding ID | Title | Severity | Status | Selected for Part 1 Fix |
| :--- | :--- | :---: | :---: | :---: |
| **F-01** | Unauthenticated Account Takeover & Plaintext Password Storage | **Critical** | **Fixed** | **Yes** |
| **F-02** | SQL Injection via Unsanitized `sortBy` and `order` Parameters | **Critical** | **Fixed** | **Yes** |
| **F-03** | Cross-Tenant Ticket & Comment Disclosure (IDOR) on `GET /:id` | **Critical** | **Fixed** | **Yes** |
| **F-04** | Unauthorized and Cross-Tenant Ticket Claiming (`PATCH /:id/assign`) | **High** | **Fixed** | **Yes** |
| **F-05** | Internal Agent Notes (`is_internal`) Leaked to Requesters | **High** | Confirmed | **Yes** |
| **F-06** | Missing Admin Role Guard & Org Check on `DELETE /api/tickets/:id` | **High** | Confirmed | No |
| **F-07** | Off-by-One Pagination Offset Skips First 20 Tickets (Page 1) | **High** | Confirmed | No |
| **F-08** | Non-Atomic Race Condition in Ticket Assignment Concurrency | **Medium** | Confirmed | No |
| **F-09** | Requesters Permitted to Post Internal Notes (`is_internal: true`) | **Medium** | Confirmed | No |
| **F-10** | Missing Input Validation for Ticket Priority Enum on Creation | **Medium** | Confirmed | No |

---

## 6. Detailed Findings

### F-01: Unauthenticated Account Takeover & Plaintext Password Storage
- **Finding ID**: `F-01`
- **Title**: Unauthenticated Arbitrary Account Takeover and Unhashed Password Storage in `/api/auth/invite/accept`
- **Severity**: Critical
- **Confirmed Status**: Confirmed (Remediation: **Fixed**)
- **Selected Status**: Selected
- **Exact File Path**: `server/src/routes/auth.js`
- **Exact Line Range**: Lines 42–54 (originally); refactored into secure creation and acceptance handlers
- **Route / Function Name**: `router.post('/invite/accept', ...)` & `router.post('/invite', ...)`
- **Relevant Code Snippet**:
  ```javascript
  router.post('/invite/accept', async (req, res, next) => {
    try {
      const { userId, password } = req.body;
      if (!userId || !password) {
        return res.status(400).json({ error: 'userId and password are required' });
      }

      await query('UPDATE users SET password_hash = ? WHERE id = ?', [password, userId]);
      res.json({ ok: true });
    } catch (err) {
      next(err);
    }
  });
  ```
- **Problem Explanation**: 
  The endpoint accepts an arbitrary `userId` from the unauthenticated client body and immediately executes an `UPDATE` on the `users` table. There is no verification of an invitation token, signature, or previous session. Furthermore, the submitted password is saved directly into the `password_hash` column without hashing via `bcrypt.hash()`.
- **Security / Business Impact**: 
  Any unauthenticated attacker can reset the password of any user in the system (including system administrators) by sending their `userId`. Additionally, because `server/src/routes/auth.js` checks passwords with `bcrypt.compare()`, storing plaintext corrupts user authentication and exposes credentials in plaintext in the database.
- **Safe Reproduction Steps**:
  1. Send an unauthenticated HTTP POST to `http://localhost:4000/api/auth/invite/accept` with body `{"userId": 1, "password": "NewPassword123!"}`.
  2. Inspect the `users` table: user ID 1 now has a plaintext password stored without any verification or authorization check.
- **Recommended Fix**:
  1. Implement a cryptographically signed, expiring invitation token (e.g., JWT or dedicated token table) containing the target user ID and tenant ID.
  2. Verify the invite token before allowing the password change.
  3. Hash the password with `await bcrypt.hash(password, 10)` before writing to `password_hash`.
- **Remediation Note (Fixed)**:
  - **Root Cause**: Complete absence of authentication or invitation token validation on `/api/auth/invite/accept`, coupled with unhashed password storage directly into `password_hash`.
  - **Files Changed**:
    - `db/schema.sql`: Added `invitations` table with foreign key to `users(id)`, expiration timestamp, used timestamp, and unique index on `token_hash`.
    - `server/src/routes/auth.js`: Added authenticated admin-only `POST /api/auth/invite` endpoint (restricted to admin's organization) generating 256-bit cryptographically secure random tokens (`crypto.randomBytes(32)`), storing only the SHA-256 hash. Reimplemented `POST /api/auth/invite/accept` to require `{ token, password }` inside a database transaction with `SELECT ... FOR UPDATE`, ensuring single-use token consumption, rejection of expired/invalid tokens, rejection of arbitrary `userId`, and password hashing using `bcrypt.hash(password, 10)`.
  - **Tests Performed**: 22 automated test assertions in `server/test-invite-verification.js` passing 100% (arbitrary `userId` attacks rejected, invalid/missing/expired/reused tokens rejected, non-admin invite creation rejected, cross-org invite creation rejected, bcrypt hash verification confirmed, and successful login with new password confirmed).
  - **Limitations & Assumptions**: In this local development environment without an SMTP/email server, the raw invitation token is returned in the admin's API response for testing. In production, this token must be delivered strictly out-of-band via email.

---

### F-02: SQL Injection via Unsanitized `sortBy` and `order`
- **Finding ID**: `F-02`
- **Title**: SQL Injection via Unsanitized `sortBy` and `order` in Ticket Listing
- **Severity**: Critical
- **Confirmed Status**: Confirmed (Remediation: **Fixed**)
- **Selected Status**: Selected
- **Exact File Paths & Lines**: 
  - `server/src/routes/tickets.js` (Lines 22–24)
  - `server/src/services/ticketService.js` (Lines 2–20, 30–36)
- **Route / Function Name**: `listTickets()` / `GET /api/tickets`
- **Relevant Code Snippet**:
  ```javascript
  // server/src/routes/tickets.js
  sortBy: req.query.sortBy || 'created_at',
  order: req.query.order || 'desc',

  // server/src/services/ticketService.js (original vulnerable query)
  const rows = await query(
    `SELECT t.id, t.subject, t.status, t.priority, t.created_at, t.updated_at,
            t.assignee_id, u.name AS assignee_name, r.name AS requester_name
       FROM tickets t
       LEFT JOIN users u ON u.id = t.assignee_id
       JOIN users r ON r.id = t.requester_id
      WHERE ${whereSql}
      ORDER BY t.${sortBy} ${order}
      LIMIT ? OFFSET ?`,
    [...params, PAGE_SIZE, offset]
  );
  ```
- **Problem Explanation**: 
  User-supplied query parameters `sortBy` and `order` were directly concatenated into the SQL template string without validation or sanitization. Because MySQL prepared statement placeholders (`?`) do not support dynamic identifiers or keywords in `ORDER BY`, string interpolation without a strict whitelist created an injection point.
- **Security / Business Impact**: 
  Authenticated users could inject arbitrary SQL expressions into the `ORDER BY` clause, allowing database fingerprinting, potential data exfiltration via boolean/time-based inference, and database Denial of Service.
- **Safe Reproduction Steps**:
  1. Authenticate to obtain a valid JWT token.
  2. Issue a request to `GET /api/tickets?sortBy=created_at%20AND%201=1` or `GET /api/tickets?order=DESC,%20(SELECT%201)`.
  3. Observe that arbitrary expressions were parsed and evaluated directly by MySQL.
- **Recommended Fix**:
  Implement a strict whitelist validation for allowed sorting columns and directions:
  ```javascript
  const ALLOWED_SORT_COLUMNS = {
    created_at: 't.created_at',
    updated_at: 't.updated_at',
    priority: 't.priority',
    status: 't.status',
  };
  const safeSortBy = ALLOWED_SORT_COLUMNS[sortBy] || 't.created_at';
  const safeOrder = String(order).toUpperCase() === 'ASC' ? 'ASC' : 'DESC';
  ```
- **Remediation Note (Fixed)**:
  - **Root Cause**: Raw query parameters `sortBy` and `order` were interpolated directly into the SQL string template (`ORDER BY t.${sortBy} ${order}`) without validation or sanitization against SQL injection.
  - **Files Changed**:
    - `server/src/services/ticketService.js`: Implemented `SORT_FIELDS` allowlist mapping (`created_at`, `createdAt`, `updated_at`, `updatedAt`, `priority`, `status`, `id`) to fixed SQL column identifiers (`t.created_at`, `t.updated_at`, etc.), and `SORT_ORDERS` allowlist (`asc` -> `'ASC'`, `desc` -> `'DESC'`).
  - **Allowlist Design**:
    ```javascript
    const SORT_FIELDS = {
      created_at: 't.created_at',
      createdAt: 't.created_at',
      updated_at: 't.updated_at',
      updatedAt: 't.updated_at',
      priority: 't.priority',
      status: 't.status',
      id: 't.id',
    };
    const SORT_ORDERS = { asc: 'ASC', desc: 'DESC' };
    ```
  - **Safe Defaults**: Any unlisted or invalid `sortBy` value falls back safely to `'t.created_at'`. Any unlisted or invalid `order` value falls back safely to `'DESC'`. Raw user input is never interpolated into the SQL statement.
  - **Actual Tests Run**: Executed automated test suite `server/test-sorting-verification.js` covering 45 assertions:
    - Default sorting returns 200 OK with valid ticket rows.
    - Every supported sort field (`created_at`, `updated_at`, `priority`, `status`, `id`, `createdAt`, `updatedAt`) verified.
    - Both `asc` and `desc` directions verified for correct chronological ordering.
    - Invalid sort fields (e.g. `unknown_field`, `created_at, id`) safely fallback to default without error or query alteration.
    - Invalid sort directions (e.g. `sideways`, `desc, id`) safely fallback to `DESC`.
    - Injection-like inputs (`-- comment`, `1;SELECT 1`, `users.name`, etc.) safely handled with 200 OK and no SQL errors or stack traces exposed.
    - Standard ticket filtering (`status`, `priority`) and pagination preserved.
  - **Actual Test Results**: 45 passed, 0 failed.

---

### F-03: Cross-Tenant Ticket & Comment Disclosure (IDOR)
- **Finding ID**: `F-03`
- **Title**: Cross-Tenant Ticket & Comment Disclosure (IDOR) on `GET /api/tickets/:id`
- **Severity**: Critical
- **Confirmed Status**: Confirmed (Remediation: **Fixed**)
- **Selected Status**: Selected
- **Exact File Path**: `server/src/routes/tickets.js` & `server/src/services/ticketService.js`
- **Exact Line Range**: `tickets.js` (Lines 31–43) & `ticketService.js` (Lines 76–90)
- **Route / Function Name**: `router.get('/:id', ...)` & `getTicketById(id, orgId)`
- **Relevant Code Snippet**:
  ```javascript
  // server/src/routes/tickets.js (original vulnerable handler)
  router.get('/:id', requireAuth, async (req, res, next) => {
    try {
      const ticket = await getTicketById(Number(req.params.id));
      if (!ticket) return res.status(404).json({ error: 'Not found' });

      const comments = await listComments(ticket.id);
      res.json({ ticket, comments });
    } catch (err) {
      next(err);
    }
  });
  ```
- **Problem Explanation**: 
  When a user requested a specific ticket by ID, the route queried `getTicketById(id)` without verifying that `ticket.org_id === req.user.orgId`.
- **Security / Business Impact**: 
  Direct Object Reference (IDOR) vulnerability violating the fundamental multi-tenant isolation requirement of the application. Any user belonging to *Cobalt Logistics* could view confidential support tickets and customer communications belonging to *Northwind Trading*.
- **Safe Reproduction Steps**:
  1. Log in as `user1@cobalt.test` (Organization 2).
  2. Send a `GET /api/tickets/1` request (where ticket ID 1 belongs to Organization 1).
  3. The server previously returned `200 OK` with the full ticket subject, description, requester email, and all comments from Organization 1.
- **Recommended Fix**:
  Enforce tenant ownership verification before returning ticket data:
  ```javascript
  const ticket = await getTicketById(Number(req.params.id));
  if (!ticket || ticket.org_id !== req.user.orgId) {
    return res.status(404).json({ error: 'Not found' });
  }
  ```
- **Remediation Note (Fixed)**:
  - **Root Cause**: `getTicketById` only filtered by `t.id = ?` without an organization boundary condition, allowing any authenticated user to fetch tickets and comments from foreign tenants via IDOR.
  - **Exact Files Changed**:
    - `server/src/services/ticketService.js`: Updated `getTicketById(id, orgId)` to add parameterized `t.org_id = ?` directly in the database SQL query whenever `orgId` is supplied.
    - `server/src/routes/tickets.js`: Updated `GET /api/tickets/:id` to validate numeric ID format and pass `req.user.orgId` directly to `getTicketById(ticketId, req.user.orgId)`. If no matching ticket exists in the user's organization, the route immediately returns safe `404 Not Found` without fetching comments.
  - **Authorization Condition**: `t.id = ? AND t.org_id = ?` enforced at the database layer via prepared statement parameters `[id, orgId]`.
  - **Actual Tests Run**: Executed automated test suite `server/test-tenant-isolation-verification.js` covering 21 assertions:
    - Same-organization ticket access confirmed (200 OK with authorized ticket and comments).
    - Cross-tenant ticket request from Northwind user to Cobalt ticket returns 404 Not Found without leaking ticket details or comments.
    - Reverse cross-tenant check from Cobalt user to Northwind ticket returns 404 Not Found, while access to own Cobalt ticket returns 200 OK.
    - Missing and invalid authentication headers rejected with 401 Unauthorized.
    - Nonexistent and malformed ticket IDs return safe 404 responses.
    - Regressions verified: Finding 1 (22/22 passed) and Finding 2 (45/45 passed).
  - **Actual Test Results**: 21 passed, 0 failed.

---

### F-04: Unauthorized and Cross-Tenant Ticket Claiming
- **Finding ID**: `F-04`
- **Title**: Unauthorized and Cross-Tenant Ticket Assignment via `PATCH /api/tickets/:id/assign`
- **Severity**: High
- **Confirmed Status**: Confirmed (Remediation: **Fixed**)
- **Selected Status**: Selected
- **Exact File Paths & Lines**: 
  - `server/src/routes/tickets.js` (Lines 67–85)
  - `server/src/services/ticketService.js` (Lines 115–165)
- **Route / Function Name**: `router.patch('/:id/assign', ...)` / `assignTicket()`
- **Relevant Code Snippet**:
  ```javascript
  // server/src/routes/tickets.js (original vulnerable handler)
  router.patch('/:id/assign', requireAuth, async (req, res, next) => {
    try {
      const result = await assignTicket(Number(req.params.id), req.user.id);
      if (!result) return res.status(404).json({ error: 'Not found' });
      if (result.conflict) {
        return res.status(409).json({ error: 'Ticket already assigned', ticket: result.ticket });
      }
      res.json(result.ticket);
    } catch (err) {
      next(err);
    }
  });
  ```
- **Problem Explanation**: 
  1. The route originally only specified `requireAuth` and lacked role authorization (`requireRole('agent', 'admin')`), allowing standard customer `requester` users to claim tickets.
  2. `assignTicket()` did not verify whether `ticket.org_id === req.user.orgId`, enabling agents from Organization B to claim tickets belonging to Organization A.
  3. No validation was performed on the target assignee's organization or role.
- **Security / Business Impact**: 
  Unauthorized role elevation and cross-tenant data modification. Requesters could assign tickets to themselves, and external agents could manipulate another organization's ticket workflow.
- **Safe Reproduction Steps**:
  1. Log in as `user1@northwind.test` (role: `requester`).
  2. Issue a `PATCH /api/tickets/<unassigned_id>/assign` request.
  3. The requester previously became the ticket's assignee and the ticket status changed to `pending`.
- **Recommended Fix**:
  1. Add `requireRole('agent', 'admin')` middleware to the route.
  2. Verify tenant ownership before executing assignment:
  ```javascript
  router.patch('/:id/assign', requireAuth, requireRole('agent', 'admin'), async (req, res, next) => {
    const ticket = await getTicketById(Number(req.params.id));
    if (!ticket || ticket.org_id !== req.user.orgId) {
      return res.status(404).json({ error: 'Not found' });
    }
    const result = await assignTicket(ticket.id, req.user.id);
    ...
  ```
- **Remediation Note (Fixed)**:
  - **Root Cause**: Missing RBAC guard (`requireRole('agent', 'admin')`) on `PATCH /api/tickets/:id/assign`, lack of tenant validation against `req.user.orgId`, and absence of assignee verification.
  - **Exact Files Changed**:
    - `server/src/routes/tickets.js`: Added `requireRole('agent', 'admin')` middleware guard. Validated ticket ID and optional `assigneeId` parameter (defaulting to `req.user.id` for self-claim). Passed `req.user.orgId` to `assignTicket`.
    - `server/src/services/ticketService.js`: Reimplemented `assignTicket(ticketId, assigneeId, orgId)` using a database transaction with `SELECT ... FOR UPDATE` row-level locking. Enforced that the ticket belongs to `orgId`, verified that the assignee exists in `orgId` and holds an `agent` or `admin` role, detected existing assignment conflicts atomically (`409 Conflict`), and updated the ticket's `assignee_id` and `status` to `pending`.
  - **Exact Authorization Rules Implemented**:
    - Callers must have role `agent` or `admin` (enforced via `requireRole('agent', 'admin')`). Requesters receive `403 Forbidden`.
    - Ticket must belong to the caller's organization (`ticket.org_id === req.user.orgId`). Cross-org attempts return `404 Not Found`.
    - Target assignee must belong to the same organization (`assignee.org_id === orgId`) and have role `agent` or `admin`. Cross-org or requester assignees return `400 Bad Request`.
  - **Actual Tests Run**: Executed automated test suite `server/test-assignment-verification.js` covering 23 assertions:
    - Unauthenticated requests rejected with 401.
    - Requester role assignment attempts rejected with 403 Forbidden.
    - Cross-tenant ticket assignment attempts return 404 Not Found.
    - Assigning to a user from another organization rejected with 400 Bad Request.
    - Assigning to a requester rejected with 400 Bad Request.
    - Nonexistent or malformed assignee IDs rejected with 400.
    - Invalid ticket IDs return safe 404 response.
    - Authorized agent self-claiming within same org succeeds with 200 OK (assignee and pending status updated in DB).
    - Claiming an already assigned ticket returns 409 Conflict with conflict payload.
    - Admin assigning ticket to another agent in same organization succeeds with 200 OK.
    - Regressions verified: Finding 1 (22/22 passed), Finding 2 (45/45 passed), and Finding 3 (21/21 passed).
  - **Actual Test Results**: 23 passed, 0 failed.

---

### F-05: Internal Agent Notes Exposed to Requesters
- **Finding ID**: `F-05`
- **Title**: Information Disclosure of Internal Agent Comments (`is_internal`) to Requesters
- **Severity**: High
- **Confirmed Status**: Confirmed
- **Selected Status**: Selected
- **Exact File Paths & Lines**: 
  - `server/src/services/ticketService.js` (Lines 69–78)
  - `server/src/routes/tickets.js` (Line 36)
- **Route / Function Name**: `listComments()` / `GET /api/tickets/:id`
- **Relevant Code Snippet**:
  ```javascript
  export async function listComments(ticketId) {
    return query(
      `SELECT c.id, c.body, c.is_internal, c.created_at, u.name AS author_name, u.role AS author_role
         FROM comments c
         JOIN users u ON u.id = c.author_id
        WHERE c.ticket_id = ?
        ORDER BY c.created_at ASC`,
      [ticketId]
    );
  }
  ```
- **Problem Explanation**: 
  `listComments` returns all comment records for a ticket without filtering by `is_internal`. The ticket retrieval endpoint returns this complete list to all authenticated users regardless of their role.
- **Security / Business Impact**: 
  Private staff discussions, internal diagnostic details, or internal escalation remarks flagged as `is_internal = 1` are leaked directly to end-user requesters.
- **Safe Reproduction Steps**:
  1. Create or identify an internal note on a ticket (`is_internal: 1`).
  2. Log in as a customer `requester` and fetch `GET /api/tickets/:id`.
  3. Note that the comment with `is_internal: 1` is returned in the API response JSON.
- **Recommended Fix**:
  Update `listComments` to filter out internal notes when the requesting user is a requester:
  ```javascript
  export async function listComments(ticketId, includeInternal = false) {
    const where = ['c.ticket_id = ?'];
    const params = [ticketId];
    if (!includeInternal) {
      where.push('c.is_internal = 0');
    }
    return query(
      `SELECT c.id, c.body, c.is_internal, c.created_at, u.name AS author_name, u.role AS author_role
         FROM comments c
         JOIN users u ON u.id = c.author_id
        WHERE ${where.join(' AND ')}
        ORDER BY c.created_at ASC`,
      params
    );
  }
  ```

---

## 7. Top Five Findings Selected for Implementation

The following five findings are selected for immediate implementation in Part 1 due to their critical security impact on authentication integrity, tenant isolation, and SQL safety:

1. **F-01**: Unauthenticated Account Takeover & Plaintext Password Storage (`server/src/routes/auth.js`)
2. **F-02**: SQL Injection via Unsanitized `sortBy` and `order` (`server/src/services/ticketService.js`)
3. **F-03**: Cross-Tenant Ticket & Comment Disclosure (IDOR) (`server/src/routes/tickets.js`)
4. **F-04**: Unauthorized and Cross-Tenant Ticket Assignment (`server/src/routes/tickets.js` & `server/src/services/ticketService.js`)
5. **F-05**: Internal Agent Notes Leaked to Requesters (`server/src/services/ticketService.js`)

---

## 8. Additional Findings Not Selected

The following genuine findings were documented during review but deferred to ensure focused remediation of the top 5 critical security blockers:

- **F-06**: Missing Admin Role Guard and Org Check on `DELETE /api/tickets/:id` (`server/src/routes/tickets.js:L75-L84`)
  - *Reason for deferral*: Deletion is an administrative action and lower exposure compared to arbitrary account takeover or cross-tenant reads.
- **F-07**: Off-by-One Pagination Offset Skips First 20 Tickets (`server/src/services/ticketService.js:L29`)
  - *Reason for deferral*: UI/data visibility defect rather than a security vulnerability.
- **F-08**: Non-Atomic Race Condition in Ticket Assignment Concurrency (`server/src/services/ticketService.js:L89-L102`)
  - *Reason for deferral*: Edge-case concurrency issue; basic assignment authorization (F-04) takes priority.
- **F-09**: Requesters Permitted to Post Internal Notes (`server/src/routes/comments.js:L11-L25`)
  - *Reason for deferral*: Lower severity than leaking internal notes to requesters (F-05).
- **F-10**: Missing Input Validation on Ticket Priority Enum (`server/src/routes/tickets.js:L45-L55`)
  - *Reason for deferral*: Minor input validation flaw resulting in database error rather than security breach.

---

## 9. Testing Summary

| Finding ID | Title | Unit Test Status | Integration Test Status | Manual Verification |
| :---: | :--- | :---: | :---: | :---: |
| **F-01** | Account Takeover in Invite Accept | **Passed** (22/22 assertions in `test-invite-verification.js`) | **Passed** | Confirmed & Verified |
| **F-02** | SQL Injection via `sortBy`/`order` | **Passed** (45/45 assertions in `test-sorting-verification.js`) | **Passed** | Confirmed & Verified |
| **F-03** | Cross-Tenant Ticket Access | **Passed** (21/21 assertions in `test-tenant-isolation-verification.js`) | **Passed** | Confirmed & Verified |
| **F-04** | Unauthorized Ticket Assignment | **Passed** (23/23 assertions in `test-assignment-verification.js`) | **Passed** | Confirmed & Verified |
| **F-05** | Internal Notes Disclosure | Not yet tested | Not yet tested | Confirmed via code review |

*Note: F-01, F-02, F-03, and F-04 have been remediated and fully verified. Finding F-05 remains in pre-implementation status pending its respective remediation task.*

---

## 10. Conclusion

The Meridian Helpdesk starter application exhibits critical security gaps that undermine authentication, data integrity, and multi-tenant isolation. Remediation of the five selected findings (F-01 through F-05) will secure authentication, protect tenant boundaries, eliminate SQL injection vectors, and restore appropriate role permissions.
