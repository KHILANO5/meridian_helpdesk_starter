# Decision Notes – Code Review Prioritization

## Overview

This document records the architectural and security rationale behind selecting the **Top 5 findings** for implementation in Part 1 of the Meridian Helpdesk assignment, as well as the justification for deferring the remaining identified findings.

---

## 1. Selection Criteria

Findings were evaluated and ranked based on four objective risk dimensions:

1. **Authentication & Authorization Integrity**: Can an unauthenticated or unauthorized party compromise accounts or perform privileged operations?
2. **Tenant Isolation**: Does the issue break the fundamental multi-tenant boundary between customer organizations?
3. **Database Security & Injection Risk**: Can arbitrary queries or destructive SQL payloads be executed against the database?
4. **Data Confidentiality & Privilege Leaks**: Is sensitive internal data leaked across permission boundaries?

---

## 2. Rationales for the Top 5 Selected Findings

### Finding 1: Unauthenticated Account Takeover & Plaintext Passwords (`F-01`)
- **Location**: `server/src/routes/auth.js` (Lines 42–54)
- **Severity**: **Critical**
- **Prioritization Rationale**:
  - This is the most severe vulnerability in the codebase.
  - Any attacker can supply an arbitrary `userId` and instantly overwrite any user's password without authentication or an invitation token.
  - It also stores passwords in plaintext, breaking subsequent `bcrypt.compare` logins and exposing credentials in the database.
  - Fixing this is mandatory before any real deployment or user onboarding.

### Finding 2: SQL Injection through `sortBy` / `order` (`F-02`)
- **Location**: `server/src/routes/tickets.js` (Lines 22–24) & `server/src/services/ticketService.js` (Line 38)
- **Severity**: **Critical**
- **Prioritization Rationale**:
  - The `ORDER BY t.${sortBy} ${order}` interpolation directly injects user-controlled query string parameters into the raw SQL string without whitelist validation or escaping.
  - Parameterized placeholders in MySQL do not work for SQL identifiers or sort directions.
  - This flaw exposes the entire database to SQL injection attacks, making it a critical priority.

### Finding 3: Cross-Tenant Ticket & Comment Disclosure (`F-03`)
- **Location**: `server/src/routes/tickets.js` (Lines 31–41)
- **Severity**: **Critical**
- **Prioritization Rationale**:
  - Multi-tenancy is a core functional requirement of Meridian Helpdesk. Customer organizations must never see each other's tickets.
  - `GET /api/tickets/:id` allows any user from *Cobalt Logistics* to read tickets, bodies, and comments from *Northwind Trading* by simply changing the ticket ID in the URL.
  - Enforcing tenant isolation on individual ticket lookups is vital for security and compliance.

### Finding 4: Unauthorized & Cross-Tenant Ticket Assignment (`F-04`)
- **Location**: `server/src/routes/tickets.js` (Lines 62–73) & `server/src/services/ticketService.js` (Lines 89–102)
- **Severity**: **High**
- **Prioritization Rationale**:
  - The `PATCH /api/tickets/:id/assign` route lacks both role authorization (`requireRole('agent', 'admin')`) and tenant verification (`ticket.org_id === req.user.orgId`).
  - This allows normal requesters to claim tickets and allows agents from one organization to claim tickets belonging to another organization.
  - Correcting this restores the fundamental support desk workflow and agent boundaries.

### Finding 5: Internal Agent Notes Exposed to Requesters (`F-05`)
- **Location**: `server/src/services/ticketService.js` (Lines 69–78) & `server/src/routes/tickets.js` (Line 36)
- **Severity**: **High**
- **Prioritization Rationale**:
  - Helpdesk systems depend on internal notes (`is_internal = 1`) for private staff communication and triage notes.
  - Currently, `listComments` returns all comments including internal notes to customer requesters.
  - Filtering comments based on the requester's role is necessary to maintain confidentiality.

---

## 3. Rationale for Deferred Findings

| Finding ID | Title | Severity | Reason for Deferral |
| :---: | :--- | :---: | :--- |
| **F-06** | Missing Admin Role Guard & Org Check on `DELETE /:id` | High | While deletion requires an admin guard, ticket reads (F-03), ticket assignments (F-04), and authentication (F-01) represent higher immediate exposure and core workflow requirements. |
| **F-07** | Off-by-One Pagination Offset Skips Page 1 Records | High | This is a data presentation and pagination logic bug rather than a direct security vulnerability. |
| **F-08** | Non-Atomic Race Condition in Ticket Assignment | Medium | Concurrency race condition under simultaneous requests; fixing the core assignment authorization and tenant check (F-04) takes higher precedence. |
| **F-09** | Requesters Permitted to Post Internal Notes | Medium | Lower severity than leaking internal notes to requesters (F-05), which discloses sensitive data. |
| **F-10** | Missing Input Validation for Priority Enum on Ticket Creation | Medium | Causes a database 500 error on malformed input rather than data breach or privilege escalation. |

---

## 4. Conclusion

Remediating findings **F-01 through F-05** addresses the most urgent security vectors across authentication, data integrity, SQL injection, tenant boundaries, and information disclosure.
