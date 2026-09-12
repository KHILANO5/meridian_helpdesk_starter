import express from 'express';
import authRoutes from './src/routes/auth.js';
import ticketRoutes from './src/routes/tickets.js';
import commentRoutes from './src/routes/comments.js';
import { query } from './src/db/pool.js';
import { calculateSla } from './src/services/slaService.js';
import { config } from './src/config.js';

const app = express();
app.use(express.json());
app.use('/api/auth', authRoutes);
app.use('/api/tickets', ticketRoutes);
app.use('/api/tickets', commentRoutes);

// Global error handler
app.use((err, req, res, next) => {
  res.status(500).json({ error: 'Internal server error', details: err.message });
});

async function runTests() {
  const server = app.listen(0);
  const port = server.address().port;
  const baseUrl = `http://localhost:${port}/api`;

  let passed = 0;
  let failed = 0;

  function assert(condition, message) {
    if (condition) {
      console.log(`  ✓ PASS: ${message}`);
      passed++;
    } else {
      console.error(`  ✗ FAIL: ${message}`);
      failed++;
    }
  }

  console.log('\n--- STARTING VERIFICATION FOR SLA BREACH TRACKING (BACKEND) ---\n');

  try {
    // -------------------------------------------------------------------------
    // 1. UNIT TESTS: SLA Calculation Function
    // -------------------------------------------------------------------------
    console.log('Testing Unit SLA Calculations:');

    const now = Date.now();

    // 1. P1 receives a 4-hour SLA
    {
      const slaP1 = calculateSla({ priority: 'P1', created_at: new Date(now) }, now);
      assert(slaP1.priority === 'P1', 'P1 ticket priority matches P1');
      assert(slaP1.targetHours === 4, 'P1 ticket receives a 4-hour SLA target');
      const expectedDeadline = new Date(now + 4 * 3600 * 1000).toISOString();
      assert(slaP1.deadline === expectedDeadline, 'P1 deadline is exactly created_at + 4 hours');
      assert(slaP1.breached === false, 'Newly created P1 ticket is not breached at creation time');
    }

    // 2. P2 receives a 24-hour SLA
    {
      const slaP2 = calculateSla({ priority: 'P2', created_at: new Date(now) }, now);
      assert(slaP2.priority === 'P2', 'P2 ticket priority matches P2');
      assert(slaP2.targetHours === 24, 'P2 ticket receives a 24-hour SLA target');
      const expectedDeadline = new Date(now + 24 * 3600 * 1000).toISOString();
      assert(slaP2.deadline === expectedDeadline, 'P2 deadline is exactly created_at + 24 hours');
      assert(slaP2.breached === false, 'Newly created P2 ticket is not breached at creation time');
    }

    // 3. P3 receives a 72-hour SLA
    {
      const slaP3 = calculateSla({ priority: 'P3', created_at: new Date(now) }, now);
      assert(slaP3.priority === 'P3', 'P3 ticket priority matches P3');
      assert(slaP3.targetHours === 72, 'P3 ticket receives a 72-hour SLA target');
      const expectedDeadline = new Date(now + 72 * 3600 * 1000).toISOString();
      assert(slaP3.deadline === expectedDeadline, 'P3 deadline is exactly created_at + 72 hours');
      assert(slaP3.breached === false, 'Newly created P3 ticket is not breached at creation time');
    }

    // 4. Non-breached ticket returns breached: false
    {
      // Created 2 hours ago with P1 (target 4h) -> not breached
      const twoHoursAgo = new Date(now - 2 * 3600 * 1000);
      const nonBreachedSla = calculateSla({ priority: 'P1', created_at: twoHoursAgo }, now);
      assert(nonBreachedSla.breached === false, 'Ticket created 2 hours ago with 4-hour SLA returns breached: false');
    }

    // 5. Breached ticket returns breached: true
    {
      // Created 5 hours ago with P1 (target 4h) -> breached
      const fiveHoursAgo = new Date(now - 5 * 3600 * 1000);
      const breachedSla = calculateSla({ priority: 'P1', created_at: fiveHoursAgo }, now);
      assert(breachedSla.breached === true, 'Ticket created 5 hours ago with 4-hour SLA returns breached: true');
    }

    // 6. Missing or invalid priority handling
    {
      const missingPriority = calculateSla({ created_at: new Date() });
      assert(missingPriority.priority === null, 'Missing priority returns priority: null');
      assert(missingPriority.targetHours === null, 'Missing priority returns targetHours: null');
      assert(missingPriority.deadline === null, 'Missing priority returns deadline: null');
      assert(missingPriority.breached === false, 'Missing priority returns breached: false');
      assert(missingPriority.status === 'unknown', 'Missing priority returns status: unknown');

      const invalidPriority = calculateSla({ priority: 'P99', created_at: new Date() });
      assert(invalidPriority.priority === null, 'Invalid priority returns priority: null');
      assert(invalidPriority.targetHours === null, 'Invalid priority returns targetHours: null');
      assert(invalidPriority.deadline === null, 'Invalid priority returns deadline: null');
      assert(invalidPriority.breached === false, 'Invalid priority returns breached: false');
      assert(invalidPriority.status === 'unknown', 'Invalid priority returns status: unknown');

      const invalidDate = calculateSla({ priority: 'P1', created_at: 'not-a-valid-date' });
      assert(invalidDate.deadline === null && invalidDate.status === 'unknown', 'Invalid date returns status: unknown');
    }

    // -------------------------------------------------------------------------
    // 2. INTEGRATION TESTS: HTTP Endpoints & SQL Filtering
    // -------------------------------------------------------------------------
    console.log('\nTesting Integration Endpoints & Database Behavior:');

    // Authenticate users
    const loginRes = await fetch(`${baseUrl}/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: 'user1@northwind.test', password: 'Password123!' }),
    });
    const { token: northwindToken, user: northwindUser } = await loginRes.json();
    assert(Boolean(northwindToken), 'Authenticated as Northwind user (Org 1)');

    const cobaltLoginRes = await fetch(`${baseUrl}/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: 'user1@cobalt.test', password: 'Password123!' }),
    });
    const { token: cobaltToken, user: cobaltUser } = await cobaltLoginRes.json();
    assert(Boolean(cobaltToken), 'Authenticated as Cobalt user (Org 2)');

    // Seed dedicated test tickets for deterministic SLA integration testing
    // Ticket 1: Org 1, P1, created NOW (non-breached)
    const freshTicketRes = await query(
      'INSERT INTO tickets (org_id, subject, body, status, priority, requester_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, NOW(), NOW())',
      [1, 'SLA Non-Breached Fresh Ticket', 'Recent issue', 'open', 'P1', northwindUser.id]
    );
    const nonBreachedTicketId = freshTicketRes.insertId;

    // Ticket 2: Org 1, P1, created 10 hours ago (breached)
    const tenHoursAgo = new Date(Date.now() - 10 * 3600 * 1000).toISOString().slice(0, 19).replace('T', ' ');
    const breachedTicketRes = await query(
      'INSERT INTO tickets (org_id, subject, body, status, priority, requester_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
      [1, 'SLA Breached Overdue Ticket', 'Overdue issue', 'open', 'P1', northwindUser.id, tenHoursAgo, tenHoursAgo]
    );
    const breachedTicketId = breachedTicketRes.insertId;

    // Ticket 3: Org 2, P1, created 10 hours ago (breached, in foreign org)
    const cobaltBreachedRes = await query(
      'INSERT INTO tickets (org_id, subject, body, status, priority, requester_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
      [2, 'Cobalt Overdue Ticket', 'Foreign overdue issue', 'open', 'P1', cobaltUser.id, tenHoursAgo, tenHoursAgo]
    );
    const cobaltBreachedTicketId = cobaltBreachedRes.insertId;

    // 7. Ticket detail endpoint exposes SLA data
    {
      const detailRes = await fetch(`${baseUrl}/tickets/${nonBreachedTicketId}`, {
        headers: { 'Authorization': `Bearer ${northwindToken}` },
      });
      assert(detailRes.status === 200, 'Non-breached ticket detail returns 200 OK');
      const { ticket } = await detailRes.json();
      assert(ticket && typeof ticket.sla === 'object', 'Ticket detail contains sla object');
      assert(ticket.sla.priority === 'P1', 'Ticket detail sla.priority is P1');
      assert(ticket.sla.targetHours === 4, 'Ticket detail sla.targetHours is 4');
      assert(ticket.sla.breached === false, 'Ticket detail sla.breached is false for fresh ticket');
      assert(ticket.breached === false, 'Ticket detail root breached property is false');

      const breachedDetailRes = await fetch(`${baseUrl}/tickets/${breachedTicketId}`, {
        headers: { 'Authorization': `Bearer ${northwindToken}` },
      });
      const { ticket: breachedTicket } = await breachedDetailRes.json();
      assert(breachedTicket.sla.breached === true, 'Overdue ticket detail sla.breached is true');
      assert(breachedTicket.breached === true, 'Overdue ticket detail root breached property is true');
      assert(Boolean(breachedTicket.sla.deadline), 'Overdue ticket detail provides ISO deadline string');
    }

    // 8. Ticket list endpoint exposes SLA data for every row
    {
      const listRes = await fetch(`${baseUrl}/tickets?page=0&search=SLA%20`, {
        headers: { 'Authorization': `Bearer ${northwindToken}` },
      });
      assert(listRes.status === 200, 'Ticket list returns 200 OK');
      const listData = await listRes.json();
      assert(Array.isArray(listData.rows) && listData.rows.length >= 2, 'Ticket list returns test rows');

      const allRowsHaveSla = listData.rows.every(r => r.sla && typeof r.sla === 'object' && typeof r.breached === 'boolean');
      assert(allRowsHaveSla, 'Every ticket row in list response exposes sla object and breached boolean');

      const foundFresh = listData.rows.find(r => r.id === nonBreachedTicketId);
      assert(foundFresh && foundFresh.breached === false, 'Fresh ticket in list reflects breached: false');

      const foundBreached = listData.rows.find(r => r.id === breachedTicketId);
      assert(foundBreached && foundBreached.breached === true, 'Overdue ticket in list reflects breached: true');
    }

    // 9. Breached-only filter (?breached=true)
    {
      const breachedListRes = await fetch(`${baseUrl}/tickets?page=0&search=SLA%20&breached=true`, {
        headers: { 'Authorization': `Bearer ${northwindToken}` },
      });
      assert(breachedListRes.status === 200, 'List with ?breached=true returns 200 OK');
      const breachedData = await breachedListRes.json();

      const allBreached = breachedData.rows.every(r => r.breached === true && r.sla.breached === true);
      assert(allBreached, 'Every row returned under ?breached=true is confirmed breached');

      const containsOverdue = breachedData.rows.some(r => r.id === breachedTicketId);
      assert(containsOverdue, 'Overdue ticket is included in ?breached=true results');

      const containsFresh = breachedData.rows.some(r => r.id === nonBreachedTicketId);
      assert(!containsFresh, 'Non-breached ticket is excluded from ?breached=true results');
    }

    // 10. Non-breached filter (?breached=false)
    {
      const nonBreachedListRes = await fetch(`${baseUrl}/tickets?page=0&search=SLA%20&breached=false`, {
        headers: { 'Authorization': `Bearer ${northwindToken}` },
      });
      assert(nonBreachedListRes.status === 200, 'List with ?breached=false returns 200 OK');
      const nonBreachedData = await nonBreachedListRes.json();

      const containsFresh = nonBreachedData.rows.some(r => r.id === nonBreachedTicketId);
      assert(containsFresh, 'Non-breached ticket is included in ?breached=false results');

      const containsOverdue = nonBreachedData.rows.some(r => r.id === breachedTicketId);
      assert(!containsOverdue, 'Breached ticket is excluded from ?breached=false results');
    }

    // 11. Multi-tenant isolation is preserved
    {
      const crossOrgRes = await fetch(`${baseUrl}/tickets/${cobaltBreachedTicketId}`, {
        headers: { 'Authorization': `Bearer ${northwindToken}` },
      });
      assert(crossOrgRes.status === 404, 'Northwind user cannot view Cobalt breached ticket (404 Not Found)');

      const listRes = await fetch(`${baseUrl}/tickets?breached=true`, {
        headers: { 'Authorization': `Bearer ${northwindToken}` },
      });
      const listData = await listRes.json();
      const leakedCobaltTicket = listData.rows.some(r => r.id === cobaltBreachedTicketId);
      assert(!leakedCobaltTicket, 'Cross-tenant breached tickets are NOT leaked in ?breached=true query');
    }

    // 12. Unauthenticated access remains blocked
    {
      const unauthRes = await fetch(`${baseUrl}/tickets/${breachedTicketId}`);
      assert(unauthRes.status === 401, 'Unauthenticated request to ticket details returns 401 Unauthorized');

      const unauthListRes = await fetch(`${baseUrl}/tickets?breached=true`);
      assert(unauthListRes.status === 401, 'Unauthenticated request to ticket list returns 401 Unauthorized');
    }

  } catch (err) {
    console.error('Unexpected test error:', err);
    failed++;
  } finally {
    server.close();
    console.log(`\n--- TEST RESULTS: ${passed} PASSED, ${failed} FAILED ---\n`);
    process.exit(failed > 0 ? 1 : 0);
  }
}

runTests();
