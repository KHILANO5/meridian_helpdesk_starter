import express from 'express';
import authRoutes from './src/routes/auth.js';
import ticketRoutes from './src/routes/tickets.js';
import { query } from './src/db/pool.js';

const app = express();
app.use(express.json());
app.use('/api/auth', authRoutes);
app.use('/api/tickets', ticketRoutes);

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

  console.log('\n--- STARTING VERIFICATION FOR FINDING 3 (TENANT TICKET ISOLATION) ---\n');

  try {
    // 1. Authenticate users from two distinct organizations:
    // Org 1: Northwind Trading
    const loginNorthwind = await fetch(`${baseUrl}/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: 'user1@northwind.test', password: 'Password123!' }),
    });
    const northwindUser = await loginNorthwind.json();
    const northwindToken = northwindUser.token;
    assert(Boolean(northwindToken) && northwindUser.user.orgId === 1, 'Logged in as Northwind user (Org 1)');

    // Org 2: Cobalt Logistics
    const loginCobalt = await fetch(`${baseUrl}/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: 'user1@cobalt.test', password: 'Password123!' }),
    });
    const cobaltUser = await loginCobalt.json();
    const cobaltToken = cobaltUser.token;
    assert(Boolean(cobaltToken) && cobaltUser.user.orgId === 2, 'Logged in as Cobalt user (Org 2)');

    // 2. Fetch one ticket belonging to Org 1 and one ticket belonging to Org 2 from DB
    const [ticketOrg1] = await query('SELECT id, org_id, subject FROM tickets WHERE org_id = 1 LIMIT 1');
    const [ticketOrg2] = await query('SELECT id, org_id, subject FROM tickets WHERE org_id = 2 LIMIT 1');
    assert(Boolean(ticketOrg1) && ticketOrg1.org_id === 1, `Found Org 1 ticket (ID: ${ticketOrg1.id})`);
    assert(Boolean(ticketOrg2) && ticketOrg2.org_id === 2, `Found Org 2 ticket (ID: ${ticketOrg2.id})`);

    // 3. User can view ticket from their own organization
    {
      const res = await fetch(`${baseUrl}/tickets/${ticketOrg1.id}`, {
        headers: { 'Authorization': `Bearer ${northwindToken}` },
      });
      assert(res.status === 200, 'Same-organization ticket access returns 200 OK');
      const data = await res.json();
      assert(Boolean(data.ticket) && data.ticket.id === ticketOrg1.id, 'Response contains requested ticket');
      assert(data.ticket.org_id === 1, 'Ticket org_id matches user organization');
      assert(Array.isArray(data.comments), 'Response contains comments array for authorized ticket');
    }

    // 4. User cannot view ticket from another organization (Northwind user requests Cobalt ticket)
    {
      const res = await fetch(`${baseUrl}/tickets/${ticketOrg2.id}`, {
        headers: { 'Authorization': `Bearer ${northwindToken}` },
      });
      assert(res.status === 404, 'Cross-organization ticket request returns 404 Not Found');
      const data = await res.json();
      assert(data.error === 'Not found', 'Safe generic "Not found" error returned');
      assert(!data.ticket, 'Cross-organization response does NOT expose ticket details');
      assert(!data.comments, 'Cross-organization response does NOT expose comments');
    }

    // 5. Reverse cross-organization check (Cobalt user requests Northwind ticket)
    {
      const resCross = await fetch(`${baseUrl}/tickets/${ticketOrg1.id}`, {
        headers: { 'Authorization': `Bearer ${cobaltToken}` },
      });
      assert(resCross.status === 404, 'Cobalt user accessing Northwind ticket returns 404 Not Found');
      const dataCross = await resCross.json();
      assert(!dataCross.ticket && !dataCross.comments, 'Cross-tenant data completely shielded from Cobalt user');

      // Cobalt user accessing their own ticket succeeds
      const resOwn = await fetch(`${baseUrl}/tickets/${ticketOrg2.id}`, {
        headers: { 'Authorization': `Bearer ${cobaltToken}` },
      });
      assert(resOwn.status === 200, 'Cobalt user accessing their own ticket returns 200 OK');
      const dataOwn = await resOwn.json();
      assert(dataOwn.ticket.id === ticketOrg2.id && dataOwn.ticket.org_id === 2, 'Cobalt ticket correctly returned to Cobalt user');
    }

    // 6. Missing authentication is rejected
    {
      const res = await fetch(`${baseUrl}/tickets/${ticketOrg1.id}`);
      assert(res.status === 401, 'Request without Authorization header returns 401 Unauthorized');
    }

    // 7. Invalid authentication is rejected
    {
      const res = await fetch(`${baseUrl}/tickets/${ticketOrg1.id}`, {
        headers: { 'Authorization': 'Bearer invalid.or.corrupt.token' },
      });
      assert(res.status === 401, 'Request with invalid token returns 401 Unauthorized');
    }

    // 8. Nonexistent ticket ID returns 404
    {
      const res = await fetch(`${baseUrl}/tickets/99999999`, {
        headers: { 'Authorization': `Bearer ${northwindToken}` },
      });
      assert(res.status === 404, 'Nonexistent ticket ID returns 404 Not Found');
      const data = await res.json();
      assert(data.error === 'Not found', 'Safe 404 error returned for nonexistent ticket');
    }

    // 9. Malformed ticket ID returns 404
    {
      const res = await fetch(`${baseUrl}/tickets/non_numeric_id`, {
        headers: { 'Authorization': `Bearer ${northwindToken}` },
      });
      assert(res.status === 404, 'Malformed non-numeric ticket ID returns 404 Not Found');
    }

  } catch (err) {
    console.error('Unexpected test failure:', err);
    failed++;
  } finally {
    server.close();
    console.log(`\n--- TEST RESULTS: ${passed} PASSED, ${failed} FAILED ---\n`);
    process.exit(failed > 0 ? 1 : 0);
  }
}

runTests();
