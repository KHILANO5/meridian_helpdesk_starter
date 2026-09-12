# Decision Notes – Code Review Prioritization & Architecture

## 1. Overview

This document records the architectural and security rationale behind prioritizing and selecting the **Top 5 findings** for remediation in Part 1 of the Meridian Helpdesk assignment, as well as the justification for deferring the remaining identified findings.

---

## 2. Selection Criteria

Findings discovered during the initial codebase audit were evaluated and ranked using objective risk and business impact dimensions:

1. **Account Takeover Risk**: Does the vulnerability allow unauthorized or unauthenticated parties to compromise user accounts or elevate privileges?
2. **SQL Injection Risk**: Can arbitrary SQL payloads or untrusted input alter query structure, compromise database integrity, or exfiltrate data?
3. **Cross-Organization Data Exposure (Multi-Tenancy Breach)**: Does the flaw violate tenant isolation, allowing customer organizations to access each other's tickets, messages, or confidential records?
4. **Unauthorized Data Modification**: Can unprivileged users modify state, claim work items, or reassign resources without appropriate role authorization?
5. **Confidential Information Disclosure**: Are internal staff notes, diagnostic remarks, or administrative metadata leaked across permission boundaries to customer requesters?
6. **Severity and Practical Exploitability**: How easily can the vulnerability be exploited, and what is the severity of immediate business damage?

---

## 3. Why Findings F1–F5 Were Prioritized

### Finding 1: Unauthenticated Password Reset & Plaintext Password Storage (`F-01`)
- **Location**: `server/src/routes/auth.js` & `db/schema.sql`
- **Severity**: **Critical**
- **Rationale**:
  - Unauthenticated endpoints allowing arbitrary password modification represent the most catastrophic vulnerability in any web application.
  - An attacker could overwrite administrator credentials simply by supplying a numeric `userId`.
  - Furthermore, storing passwords without hashing broke authentication and exposed plaintext credentials in the database.
  - Resolving this was an absolute prerequisite to running a secure system.

### Finding 2: SQL Injection via `sortBy` and `order` (`F-02`)
- **Location**: `server/src/services/ticketService.js` & `server/src/routes/tickets.js`
- **Severity**: **Critical**
- **Rationale**:
  - Direct string interpolation (`ORDER BY t.${sortBy} ${order}`) bypassed query parameterization.
  - Parameterized placeholders in MySQL do not sanitize SQL identifiers or sort direction keywords.
  - This exposed the entire database to arbitrary SQL injection, stacked queries, and denial-of-service payloads.

### Finding 3: Cross-Tenant Ticket & Comment Disclosure (IDOR) (`F-03`)
- **Location**: `server/src/routes/tickets.js` & `server/src/services/ticketService.js`
- **Severity**: **Critical**
- **Rationale**:
  - Multi-tenant boundary isolation is a foundational design requirement of Meridian Helpdesk. Customer organizations must never access each other's data.
  - `GET /api/tickets/:id` lacked tenant validation (`org_id`), enabling any authenticated user to inspect confidential tickets and comments across tenant boundaries via Insecure Direct Object References (IDOR).

### Finding 4: Unauthorized & Cross-Tenant Ticket Assignment (`F-04`)
- **Location**: `server/src/routes/tickets.js` & `server/src/services/ticketService.js`
- **Severity**: **High**
- **Rationale**:
  - Ticket claiming lacked both role authorization (`requireRole('agent', 'admin')`) and tenant verification.
  - Customer requesters could assign tickets to themselves, and external agents could claim or reassign tickets across tenants.
  - Enforcing RBAC role checks and tenant scoping restored core helpdesk workflow integrity.

### Finding 5: Internal Agent Notes Exposed to Requesters (`F-05`)
- **Location**: `server/src/services/ticketService.js`, `server/src/routes/tickets.js`, `server/src/routes/comments.js`
- **Severity**: **High**
- **Rationale**:
  - Helpdesk systems depend on private internal notes (`is_internal = 1`) for agent troubleshooting and escalation discussions.
  - The API returned all comments to customer requesters without checking visibility, leaking private staff communications.
  - Filtering notes on the server side ensured confidential conversations remain hidden from customer requesters.

---

## 4. Why Other Findings Were Deferred

In accordance with the assignment instructions, exactly five findings were to be selected, implemented, and tested in Part 1. The remaining findings were documented and deferred:

| Finding ID | Title | Severity | Reason for Deferral |
| :---: | :--- | :---: | :--- |
| **F-06** | Missing Admin Role Guard & Org Check on `DELETE /:id` | High | Ticket deletion is an administrative action. Ticket read disclosure (F-03), ticket assignment tampering (F-04), and account takeover (F-01) represented higher immediate operational risk and broader attack surfaces. |
| **F-07** | Off-by-One Pagination Offset Skips First 20 Tickets | High | Presentation and pagination calculation bug rather than an exploitable security vulnerability. |
| **F-08** | Non-Atomic Race Condition in Ticket Assignment Concurrency | Medium | The assignment flow was improved through transaction and row-lock handling while implementing F-04. It remains documented as a separate finding because it was not independently selected, analyzed, and tested as one of the five prioritized findings. |
| **F-09** | Requesters Permitted to Post Internal Notes | Medium | Lower severity than leaking private internal staff notes to requesters (F-05). Server-side sanitization was implemented alongside F-05. |
| **F-10** | Missing Input Validation for Priority Enum on Ticket Creation | Medium | Results in an unhandled database error (500) rather than unauthorized access, data exposure, or privilege escalation. |

### Scope Discipline
Implementing additional fixes beyond the top five would have expanded the project scope, increased the risk of regressions, and diverged from the assignment mandate. Deferred findings are thoroughly cataloged in `docs/code-review-report.md` for resolution in future development sprints.

---

## 5. Trade-offs and Limitations

The implementations made for F1 through F5 adhere strictly to the project's existing architecture, conventions, and dependencies:

1. **Invitation Token Delivery**: In this local development environment, an SMTP mail server or external notification service is not configured. The raw invitation token is returned in the administrative API response (`POST /api/auth/invite`) for testing. In production, this token must be delivered strictly out-of-band via email.
2. **Staff Role Permissions**: Internal note visibility and assignment capabilities follow the project's established RBAC model where `'agent'` and `'admin'` are designated staff roles. Customer `'requester'` users are restricted to public comments and ticket creation.
3. **API Conventions & Error Responses**: The project's existing response formats (`{ error: string }`, `{ ok: boolean }`) and standard HTTP status codes (`400`, `401`, `403`, `404`, `409`) were preserved to prevent breaking client expectations.
4. **Allowlist Sorting Scope**: Sorting is restricted to ticket table attributes. Joins with external tables (such as user names) are not supported in `ORDER BY` to maintain index predictability and prevent injection attacks.

---

## 6. Verification Approach

A comprehensive, multi-tiered testing strategy was utilized to validate the remediations:

1. **Dedicated Verification Test Suites**: A focused test file was authored for each finding:
   - `server/test-invite-verification.js` (F-01)
   - `server/test-sorting-verification.js` (F-02)
   - `server/test-tenant-isolation-verification.js` (F-03)
   - `server/test-assignment-verification.js` (F-04)
   - `server/test-internal-notes-verification.js` (F-05)
2. **Continuous Regression Testing**: After each successive fix was implemented, all previously completed test suites were executed to ensure zero regressions across prior remediations.
3. **Deterministic Database State**: Tests utilized deterministic seed accounts (`Password123!`) and transactional rollbacks or `npm run db:reset` to guarantee repeatable test execution without database corruption.
4. **Strict Assertion Accounting**: Each test suite prints detailed assertion statuses and exits with non-zero codes on any failure. All 136 total assertions passed with 0 failures.

---

## 7. Part 2: Backend SLA Breach Tracking Decisions

To fulfill the requirements of Part 2 (SLA Breach Tracking), the backend implementation adheres to the following architectural decisions:

### 1. SLA Clock Start Time
* **Decision**: The SLA clock begins at the ticket's `created_at` timestamp.
* **Rationale**: The SLA obligation begins the moment a customer submits a ticket. `created_at` is immutable, recorded automatically by the database on creation, and represents the true start of the customer wait time.

### 2. SLA Duration and Priority Mapping
* **Decision**: Target durations are derived directly from the application configuration in `server/src/config.js`:
  * **P1**: 4 hours
  * **P2**: 24 hours
  * **P3**: 72 hours
* **Rationale**: Targets are maintained as single-source-of-truth constants in `config.slaTargets`, avoiding magic numbers or duplicated constants across services.

### 3. Server-Side Deadline Calculation
* **Decision**: Deadlines are calculated on the server as `deadline = new Date(created_at.getTime() + targetHours * 3600 * 1000).toISOString()`.
* **Rationale**: Centralizing deadline computation in `server/src/services/slaService.js` guarantees consistency across both list and detail endpoints and eliminates client clock skew or manipulation.

### 4. UTC-Compatible Breach Evaluation
* **Decision**: Breach state is evaluated using UTC-compatible epoch timestamps: `breached = Date.now() > deadlineTime`.
* **Rationale**: Comparing absolute epoch milliseconds (`getTime()`) in Node.js and using MySQL's `NOW() > DATE_ADD(created_at, INTERVAL ? HOUR)` prevents timezone skew across diverse client environments.

### 5. Missing or Invalid Priority Handling
* **Decision**: If a ticket's priority is missing or unrecognized (e.g. `null`, `'P99'`, or non-string), the calculation does not guess a duration. It returns:
  ```json
  {
    "priority": null,
    "targetHours": null,
    "deadline": null,
    "breached": false,
    "status": "unknown"
  }
  ```
* **Rationale**: Prevents generating misleading breach alerts or false positive escalation flags for tickets with unassigned or invalid priorities.

### 6. Closed / Resolved Ticket Behavior
* **Decision & Behavior**:
  * SLA breach is calculated from the original `created_at` timestamp and priority.
  * The SLA calculation does not automatically stop when a ticket becomes resolved or closed.
  * A closed or resolved ticket may still show `SLA Breached` if its original SLA deadline passed.
  * Agents can combine `breached=true` with `status=open` or `status=pending` to focus on active overdue work.
* **Rationale**: In accordance with rule 7, the SLA calculator does not silently close or alter ticket lifecycles. Furthermore, the database schema lacks a dedicated `resolved_at` timestamp, and exempting closed tickets would conceal historical operational SLA failures from compliance reporting.

### 7. Breached-Only Filter (`GET /api/tickets?breached=true`)
* **Decision**: The `breached` query parameter is pushed directly into the SQL `WHERE` clause using parameterized `CASE` statements:
  ```sql
  NOW() > DATE_ADD(t.created_at, INTERVAL (CASE t.priority WHEN 'P1' THEN ? WHEN 'P2' THEN ? WHEN 'P3' THEN ? END) HOUR)
  ```
  bound to `[config.slaTargets.P1, config.slaTargets.P2, config.slaTargets.P3]`.
* **Rationale**: Executing the filter at the SQL level ensures that database pagination (`LIMIT 20 OFFSET ?`) and total record counts (`COUNT(*)`) are 100% accurate, avoiding empty or truncated pages that occur with post-retrieval in-memory filtering.

---

## 8. Part 2: Frontend SLA Breach Tracking Decisions

To fulfill the requirements of Part 2 (Frontend SLA Breach Tracking), the client application adheres to the following UI and architectural decisions:

### 1. Frontend Trusts Backend Breach Result
* **Decision**: The client interface strictly reads `breached` (or `sla.breached`) from the backend API response and never attempts to determine or re-calculate whether an SLA target is breached.
* **Rationale**: The backend holds the authoritative single source of truth for SLA deadlines, business logic, and database timestamps. Relying solely on the server response guarantees zero discrepancies between the ticket list filter and individual ticket views.

### 2. No Frontend SLA Calculation
* **Decision**: The client does not use `Date.now()`, `window.performance`, or client system clocks to compute SLA status, elapsed time, or remaining duration.
* **Rationale**: Client system clocks are untrusted, prone to skew, timezone misconfigurations, or intentional user alteration. Calculating SLAs on the client would lead to inconsistent states between users in different timezones and discrepancies with server-side pagination and filters.

### 3. Red Badge Display Rules
* **Decision**: The red badge (`SLA Breached`) is rendered if and only if the backend returns `breached === true` (or `sla.breached === true`).
  * In the ticket list (`TicketList.jsx`), the badge is displayed inline adjacent to the ticket subject link (`.badge-breached`).
  * In the ticket detail view (`TicketDetail.jsx`), the badge is displayed in the main header (`<h1>`) alongside the ticket subject (`.badge-breached-detail`).
  * If a ticket is not breached (`breached === false`), no breach badge is rendered. Existing status and priority indicators remain intact and functional.
* **Rationale**: Maintains a clean, scannable UI where overdue tickets immediately stand out without visual clutter on on-time tickets.

### 4. Server-Side Breached Filter
* **Decision**: The SLA status dropdown in the ticket list filters provides three options:
  * **All tickets (SLA)**: Omits the `breached` query parameter from the API request (`breached = ''`).
  * **Breached tickets**: Passes `?breached=true` to the backend.
  * **Non-breached tickets**: Passes `?breached=false` to the backend.
* **Rationale**: The filter initiates a fresh server-side API request (`/api/tickets?...`), resetting the page index to 1 while preserving active search terms, status filters, priority filters, and sorting parameters. Filtering on the server guarantees accurate database-level pagination (`LIMIT 20 OFFSET ?`) and total record counts (`total`).

### 5. Safe Handling of Unknown / Null SLA Data
* **Decision**: In `TicketDetail.jsx`, the SLA deadline metadata (`SLA Deadline: <formatted date>`) is rendered only when `ticket.sla?.deadline` is present and valid. If `ticket.sla` or `deadline` is null, undefined, or missing, the deadline display is gracefully omitted rather than rendering `"Invalid Date"` or misleading placeholder text.
* **Rationale**: Prevents confusion or false assumptions when inspecting legacy tickets, custom priority tickets without configured SLA targets, or malformed data records.


