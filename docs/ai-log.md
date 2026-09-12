# AI Assistance Log – Meridian Helpdesk Part 1

## 1. Overview & Tools Used

This document provides a transparent, comprehensive record of the AI-assisted engineering and review process conducted for Part 1 of the Meridian Helpdesk internship assignment.

### Tools Used
- **AI Assistant**: Antigravity IDE (powered by Google DeepMind's Advanced Agentic Coding model).
- **Environment**: Node.js 18, Express 4, MySQL 8, and PowerShell on Windows.
- **Capabilities Utilized**: File inspection (`view_file`, `list_dir`, `grep_search`), code editing (`replace_file_content`, `write_to_file`), and local shell execution (`run_command` for test runs and git operations). No external mock services or unverified features were used.

---

## 2. Prompts and Tasks Summary

The engineering workflow was divided into discrete, carefully scoped phases to prevent premature fixes, prevent cross-contamination between findings, and preserve existing functionality:

### Task 1: Repository Inspection & Initial Audit
- **Prompt Intent**: Perform a read-only audit of the full repository to understand architecture, authentication, routes, middleware, and database schema, and identify 5–8 genuine security and correctness issues.
- **AI Activities**: Inspected `server/src/`, `db/schema.sql`, and client structure. Documented initial findings including unauthenticated invite acceptance, IDOR in ticket retrieval, and missing role guards.

### Task 2: Deep-Dive Verification of Findings (F-01 & F-02)
- **Prompt Intent**: Rigorously trace `/api/auth/invite/accept` to evaluate token validation and password hashing; trace `sortBy` and `order` query handling to confirm whether SQL injection is exploitable.
- **AI Activities**: Confirmed absence of an invitations table, unhashed plaintext password storage in `password_hash`, and unparameterized string concatenation (`ORDER BY t.${sortBy} ${order}`) without allowlists.

### Task 3: Documentation Preparation (Part 1 Review Artifacts)
- **Prompt Intent**: Draft `docs/code-review-report.md`, `docs/decision-notes.md`, and `docs/ai-log.md` detailing the 10 identified findings and prioritizing the top five without altering application code.
- **AI Activities**: Generated structured audit reports detailing finding descriptions, severity classifications, and reproduction steps.

### Task 4: Implementation of Finding 1 (Secure Invite & Account Takeover Prevention)
- **Prompt Intent**: Implement a minimal, complete, and secure invitation and password-set flow. Add an `invitations` table, admin-only token creation, single-use token validation, and bcrypt hashing.
- **AI Activities**: Updated `db/schema.sql`, `server/scripts/reset-db.js`, and `server/src/routes/auth.js`. Created `server/test-invite-verification.js` and verified 22 assertions.

### Task 5: Implementation of Finding 2 (SQL Injection Prevention in Sorting)
- **Prompt Intent**: Eliminate SQL injection in `listTickets` by replacing string interpolation with strict allowlist validation for `sortBy` and `order`.
- **AI Activities**: Updated `server/src/services/ticketService.js`. Created `server/test-sorting-verification.js` and verified 45 assertions. Ran F1 regression tests.

### Task 6: Implementation of Finding 3 (Cross-Tenant Ticket Isolation)
- **Prompt Intent**: Enforce organization scoping on `GET /api/tickets/:id` so users cannot access tickets or comments outside their organization.
- **AI Activities**: Updated `server/src/services/ticketService.js` and `server/src/routes/tickets.js`. Created `server/test-tenant-isolation-verification.js` and verified 21 assertions. Ran F1 and F2 regression tests.

### Task 7: Implementation of Finding 4 (Ticket Assignment Authorization)
- **Prompt Intent**: Secure `PATCH /api/tickets/:id/assign` with `requireRole('agent', 'admin')`, verify tenant ownership, ensure assignee belongs to the same organization with an agent/admin role, and handle concurrency safely.
- **AI Activities**: Updated `server/src/routes/tickets.js` and `server/src/services/ticketService.js` with `SELECT ... FOR UPDATE` transactional row locking. Created `server/test-assignment-verification.js` and verified 23 assertions. Ran F1, F2, and F3 regression tests.

### Task 8: Implementation of Finding 5 (Internal Agent Notes Privacy)
- **Prompt Intent**: Prevent disclosure of internal agent notes (`is_internal = 1`) to customer requesters on ticket details and ticket listing counters, while preserving access for agents and admins.
- **AI Activities**: Updated `server/src/services/ticketService.js`, `server/src/routes/tickets.js`, and `server/src/routes/comments.js`. Created `server/test-internal-notes-verification.js` and verified 25 assertions. Ran all regression suites.

### Task 9: Final Documentation & Repository Hygiene Review
- **Prompt Intent**: Perform a complete documentation update, verify all line numbers and test results, review `.gitignore` and local credential scripts, and perform safety checks.
- **AI Activities**: Updated `docs/code-review-report.md`, `docs/decision-notes.md`, `docs/ai-log.md`, and `.gitignore`.

---

## 3. Summary of AI-Generated Changes

| Finding | Target Files Modified | Main Implementation | Tests Created / Updated |
| :--- | :--- | :--- | :--- |
| **F-01** | `db/schema.sql`<br>`server/scripts/reset-db.js`<br>`server/src/routes/auth.js` | Added `invitations` table. Created admin-only `POST /api/auth/invite` generating 256-bit secure tokens (SHA-256 stored). Rewrote `POST /api/auth/invite/accept` with single-use consumption and bcrypt hashing (`cost = 10`). | Created `server/test-invite-verification.js` (22 assertions) |
| **F-02** | `server/src/services/ticketService.js` | Defined `SORT_FIELDS` and `SORT_ORDERS` allowlists with safe fallback defaults (`t.created_at DESC`), completely eliminating raw query interpolation. | Created `server/test-sorting-verification.js` (45 assertions) |
| **F-03** | `server/src/services/ticketService.js`<br>`server/src/routes/tickets.js` | Added `t.org_id = ?` parameterization to `getTicketById(id, orgId)`. Enforced org ID check on `GET /api/tickets/:id`, returning safe 404 on cross-tenant requests. | Created `server/test-tenant-isolation-verification.js` (21 assertions) |
| **F-04** | `server/src/routes/tickets.js`<br>`server/src/services/ticketService.js` | Added `requireRole('agent', 'admin')` to `PATCH /:id/assign`. Implemented transactional `SELECT ... FOR UPDATE` row locking, assignee org/role validation, and 409 conflict detection. | Created `server/test-assignment-verification.js` (23 assertions) |
| **F-05** | `server/src/services/ticketService.js`<br>`server/src/routes/tickets.js`<br>`server/src/routes/comments.js` | Added `c.is_internal = 0` filtering for requesters in `listComments` and `listTickets` badge counting. Restricted internal note creation in `POST /:ticketId/comments` to staff roles. | Created `server/test-internal-notes-verification.js` (25 assertions) |

---

## 4. Human Verification and Quality Gates

Every implementation step was subject to strict verification gates before moving to the next finding:

1. **Independent Code Inspection**: Verified diffs manually using `git diff` to confirm that changes only targeted the specific finding without unintended edits.
2. **Automated Unit & Integration Testing**: Ran standalone Node.js test suites against real MySQL database instances.
3. **Continuous Regression Testing**: Re-ran all accumulated verification scripts after each change:
   - After F1: Ran F1 suite (22 passed).
   - After F2: Ran F1 and F2 suites (67 passed).
   - After F3: Ran F1, F2, and F3 suites (88 passed).
   - After F4: Ran F1, F2, F3, and F4 suites (111 passed).
   - After F5: Ran F1, F2, F3, F4, and F5 suites (136 passed).
4. **Tenant & Role Boundary Verification**: Explicitly tested cross-tenant attempts between Northwind Trading (Org 1) and Cobalt Logistics (Org 2), confirming 404 Not Found responses.
5. **Requester vs. Staff Visibility Auditing**: Inspected JSON payloads to confirm that internal notes and sensitive escalation remarks were omitted from customer requester responses while visible to agents and admins.
6. **Server Startup & Live Endpoint Testing**: Verified that `server/src/index.js` boots cleanly and responds to HTTP requests.

---

## 5. Corrections, Assumptions, and Limitations

During the pairing process, several AI assumptions and edge cases were identified and corrected:

1. **Invitation Flow Scope Correction**:
   - *Initial AI Assumption*: Proposed fixing only the `POST /api/auth/invite/accept` route.
   - *Correction*: The user correctly noted that the codebase had no invitation table or token generation route. Implementing only acceptance would leave no legitimate way to generate an invitation. The solution was expanded to include `db/schema.sql` migration and admin `POST /api/auth/invite`.
2. **Race Conditions in Ticket Assignment**:
   - *Initial AI Assumption*: A basic `UPDATE` query was considered for assignment.
   - *Correction*: To prevent concurrent claiming race conditions, the implementation was upgraded to use a database transaction with `SELECT ... FOR UPDATE` row-level locking.
3. **Pagination Offset Interaction in F-05 Test**:
   - *Issue Encountered*: In `test-internal-notes-verification.js` assertion #8, a newly inserted ticket was not appearing on page 1 of `GET /api/tickets` because of the pre-existing off-by-one pagination bug (F-07: `offset = page * PAGE_SIZE`, which skips rows 1–20 on page 1).
   - *Correction*: The test was updated to query with `?page=0&search=...` to ensure deterministic row retrieval without touching or masking the deferred F-07 bug.
4. **Development Token Delivery Limitation**:
   - In production, invitation tokens must be sent via email. Since no mailer exists in the starter app, tokens are returned in the development API response.
5. **Tracked Credentials in Repository History**:
   - Identified that `server/.env` and `server/scripts/setup-db-user.js` were committed in earlier setup commits. In accordance with safety rules, these files were not deleted or rewritten, and their presence was documented for user review.

---

## 6. Final Verified Test Results

All five automated verification test suites were executed sequentially on a clean database reset. The final verified results are:

| Test File | Finding | Total Tests | Passed | Failed |
| :--- | :--- | :---: | :---: | :---: |
| `server/test-invite-verification.js` | Finding 1 (Invite & Password Flow) | 22 | 22 | 0 |
| `server/test-sorting-verification.js` | Finding 2 (SQL Injection in Sorting) | 45 | 45 | 0 |
| `server/test-tenant-isolation-verification.js` | Finding 3 (Cross-Tenant Ticket Isolation) | 21 | 21 | 0 |
| `server/test-assignment-verification.js` | Finding 4 (Ticket Assignment Authorization) | 23 | 23 | 0 |
| `server/test-internal-notes-verification.js` | Finding 5 (Internal Agent Notes Privacy) | 25 | 25 | 0 |
| **Grand Total** | **All Remediated Findings** | **136** | **136** | **0** |
