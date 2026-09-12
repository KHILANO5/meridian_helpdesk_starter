# AI Assistance Log – Code Review and Architecture Inspection

## 1. Overview

This document records the interactions, AI prompt sequences, and verification procedures utilized during Part 1 of the Meridian Helpdesk internship assignment.

Every finding, code snippet, line reference, and architectural observation in this review was independently and manually verified against the actual codebase files in `server/` and `db/` to prevent hallucinations and false positives.

---

## 2. AI Interaction Record

### Prompt Session 1: Initial Repository Inspection and Architecture Overview
- **User Intent**: Inspect existing project files and provide a beginner-friendly overview of application functionality, stack, architecture, and file inventory without modifying files.
- **AI Activities**:
  - Inspected root structure, `docker-compose.yml`, `db/schema.sql`.
  - Listed and analyzed `server/` source files (`index.js`, `config.js`, `pool.js`, `middleware/auth.js`, routes, services).
  - Listed and analyzed `client/` frontend components, Redux store, and Vite configurations.
  - Documented file purposes, exports, and relationships.
- **Outcome**: Verified that the system is an Express + MySQL backend paired with a React + Redux frontend operating under a multi-tenant model.

### Prompt Session 2: Backend Route Audit & Initial Findings Discovery
- **User Intent**: Audit backend routes focusing on authentication, authorization, multi-tenancy, input validation, and SQL queries to identify meaningful issues.
- **AI Activities**:
  - Traced `server/src/routes/auth.js` for authentication vulnerabilities.
  - Traced `server/src/routes/tickets.js` and `server/src/services/ticketService.js` for tenant isolation and authorization bugs.
  - Formulated initial findings:
    1. Unauthenticated password reset in `/api/auth/invite/accept`.
    2. Missing tenant check in `GET /api/tickets/:id`.
    3. Missing admin role check and tenant check in `DELETE /api/tickets/:id`.
- **Outcome**: Verified first set of security and authorization gaps.

### Prompt Session 3: Deep Inspection of Invitation and Password Flow
- **User Intent**: Rigorously examine `/api/auth/invite/accept` to confirm token validation, user input handling, password hashing, and invitation schema presence.
- **AI Activities**:
  - Inspected `server/src/routes/auth.js` (lines 42–54) and database schema `db/schema.sql`.
  - Grepped for invite-related tables, tokens, or helper functions across the repository.
  - Confirmed that `userId` is accepted directly from unauthenticated requests, passwords are saved unhashed, and no invitation table or token middleware exists.
- **Outcome**: Confirmed Finding F-01 as Critical Account Takeover vulnerability.

### Prompt Session 4: Comprehensive Repository Scan for Additional Issues
- **User Intent**: Inspect remaining backend modules to discover additional genuine issues and rank them by severity.
- **AI Activities**:
  - Inspected dynamic SQL query generation in `server/src/services/ticketService.js`.
  - Audited pagination offset arithmetic.
  - Audited comment privacy (`is_internal`) in ticket retrieval and creation routes.
  - Audited ticket assignment logic and concurrency safety.
- **Outcome**: Identified and confirmed 10 total genuine issues across the codebase.

### Prompt Session 5: In-Depth Verification of SQL Injection (`F-02`)
- **User Intent**: Trace the complete request lifecycle of `req.query.sortBy` and `req.query.order` through Express routes down to `mysql2` execution.
- **AI Activities**:
  - Verified lack of middleware sanitization in `server/src/index.js` and `server/src/middleware/auth.js`.
  - Inspected string interpolation `ORDER BY t.${sortBy} ${order}` in `server/src/services/ticketService.js:L38`.
  - Confirmed `mysql2` driver behavior when receiving unparameterized SQL strings.
- **Outcome**: Verified Finding F-02 as a Confirmed Critical SQL injection vulnerability.

---

## 3. Verification & Validation Protocol

To ensure 100% accuracy of the review artifacts:
1. **Direct Codebase Cross-Referencing**: Every line range and code block quoted in `docs/code-review-report.md` was matched against the active files on disk.
2. **Exclusion of Hallucinated Files**: Verified that files not present in the codebase (such as `routes/users.js` or `routes/organizations.js`) were explicitly reported as "Not found in the inspected code".
3. **Driver & Engine Behavioral Analysis**: Verified SQL behavior against MySQL 8 and `mysql2` promise driver specifications.
4. **No Destructive Actions or Premature Fixes**: Maintained strict read-only review boundaries as requested.

---

## 4. Current State Notice

As of this documentation stage:
- **Application Source Files Modified**: None.
- **Automated Fixes Applied**: None.
- **Vulnerabilities Fixed**: None.
- **Testing Status**: Pre-implementation code review confirmed; dynamic runtime testing pending implementation in subsequent phases.
