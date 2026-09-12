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

  console.log('\n--- STARTING VERIFICATION FOR FINDING 4 (TICKET ASSIGNMENT AUTHORIZATION) ---\n');

  try {
    // 1. Authenticate users with different roles across organizations
    // Org 1: Northwind
    // Admin: Nadia Novak
    const loginNorthwindAdmin = await fetch(`${baseUrl}/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: 'admin@northwind.test', password: 'Password123!' }),
    });
    const nwAdmin = await loginNorthwindAdmin.json();
    const nwAdminToken = nwAdmin.token;
    assert(Boolean(nwAdminToken) && nwAdmin.user.role === 'admin', 'Logged in as Northwind Admin (Org 1)');

    // Agent: Marco Moreau
    const loginNorthwindAgent = await fetch(`${baseUrl}/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: 'agent1@northwind.test', password: 'Password123!' }),
    });
    const nwAgent = await loginNorthwindAgent.json();
    const nwAgentToken = nwAgent.token;
    assert(Boolean(nwAgentToken) && nwAgent.user.role === 'agent', 'Logged in as Northwind Agent 1 (Org 1)');

    // Agent 2: Priya Rahman
    const loginNorthwindAgent2 = await fetch(`${baseUrl}/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: 'agent2@northwind.test', password: 'Password123!' }),
    });
    const nwAgent2 = await loginNorthwindAgent2.json();
    const nwAgent2Id = nwAgent2.user.id;

    // Requester: Ben Brooks
    const loginNorthwindRequester = await fetch(`${baseUrl}/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: 'user1@northwind.test', password: 'Password123!' }),
    });
    const nwRequester = await loginNorthwindRequester.json();
    const nwRequesterToken = nwRequester.token;
    assert(Boolean(nwRequesterToken) && nwRequester.user.role === 'requester', 'Logged in as Northwind Requester (Org 1)');

    // Org 2: Cobalt Logistics
    // Agent: Grace Gomez
    const loginCobaltAgent = await fetch(`${baseUrl}/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: 'agent1@cobalt.test', password: 'Password123!' }),
    });
    const cbAgent = await loginCobaltAgent.json();
    const cbAgentToken = cbAgent.token;
    const cbAgentId = cbAgent.user.id;
    assert(Boolean(cbAgentToken) && cbAgent.user.role === 'agent' && cbAgent.user.orgId === 2, 'Logged in as Cobalt Agent (Org 2)');

    // Find or create test tickets in Org 1 and Org 2
    // Unassigned ticket in Org 1:
    const [unassignedTicket1] = await query(
      'SELECT id, org_id, assignee_id FROM tickets WHERE org_id = 1 AND assignee_id IS NULL LIMIT 1'
    );
    assert(Boolean(unassignedTicket1), `Found unassigned ticket in Org 1 (ID: ${unassignedTicket1.id})`);

    // Unassigned ticket in Org 2:
    const [unassignedTicket2] = await query(
      'SELECT id, org_id, assignee_id FROM tickets WHERE org_id = 2 AND assignee_id IS NULL LIMIT 1'
    );
    assert(Boolean(unassignedTicket2), `Found unassigned ticket in Org 2 (ID: ${unassignedTicket2.id})`);

    // 2. Unauthenticated user cannot assign a ticket
    {
      const res = await fetch(`${baseUrl}/tickets/${unassignedTicket1.id}/assign`, {
        method: 'PATCH',
      });
      assert(res.status === 401, 'Unauthenticated assignment request returns 401 Unauthorized');
    }

    // 3. Requester cannot assign a ticket
    {
      const res = await fetch(`${baseUrl}/tickets/${unassignedTicket1.id}/assign`, {
        method: 'PATCH',
        headers: { 'Authorization': `Bearer ${nwRequesterToken}` },
      });
      assert(res.status === 403, 'Requester role attempting to assign ticket returns 403 Forbidden');
    }

    // 4. User cannot assign a ticket belonging to another organization
    {
      // Northwind Agent attempts to claim Cobalt ticket
      const res = await fetch(`${baseUrl}/tickets/${unassignedTicket2.id}/assign`, {
        method: 'PATCH',
        headers: { 'Authorization': `Bearer ${nwAgentToken}` },
      });
      assert(res.status === 404, 'Agent claiming cross-organization ticket returns 404 Not Found');
    }

    // 5. User cannot assign a ticket to an assignee from another organization
    {
      // Northwind Admin attempts to assign an Org 1 ticket to a Cobalt Agent (cbAgentId)
      const res = await fetch(`${baseUrl}/tickets/${unassignedTicket1.id}/assign`, {
        method: 'PATCH',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${nwAdminToken}`,
        },
        body: JSON.stringify({ assigneeId: cbAgentId }),
      });
      assert(res.status === 400, 'Assigning ticket to user from different organization returns 400 Bad Request');
    }

    // 6. User cannot assign a ticket to a requester (must be agent or admin)
    {
      const res = await fetch(`${baseUrl}/tickets/${unassignedTicket1.id}/assign`, {
        method: 'PATCH',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${nwAdminToken}`,
        },
        body: JSON.stringify({ assigneeId: nwRequester.user.id }),
      });
      assert(res.status === 400, 'Assigning ticket to requester role returns 400 Bad Request');
    }

    // 7. Nonexistent assignee is rejected
    {
      const res = await fetch(`${baseUrl}/tickets/${unassignedTicket1.id}/assign`, {
        method: 'PATCH',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${nwAdminToken}`,
        },
        body: JSON.stringify({ assigneeId: 999999 }),
      });
      assert(res.status === 400, 'Nonexistent assignee ID returns 400 Bad Request');
    }

    // 8. Invalid ticket ID returns 404
    {
      const res = await fetch(`${baseUrl}/tickets/invalid_id/assign`, {
        method: 'PATCH',
        headers: { 'Authorization': `Bearer ${nwAgentToken}` },
      });
      assert(res.status === 404, 'Invalid non-numeric ticket ID returns 404 Not Found');
    }

    // 9. Authorized agent can claim ticket in their own organization (self-claim)
    {
      const res = await fetch(`${baseUrl}/tickets/${unassignedTicket1.id}/assign`, {
        method: 'PATCH',
        headers: { 'Authorization': `Bearer ${nwAgentToken}` },
      });
      assert(res.status === 200, 'Authorized agent self-claiming ticket returns 200 OK');
      const data = await res.json();
      assert(data.assignee_id === nwAgent.user.id, 'Ticket assignee_id matches claiming agent ID');
      assert(data.status === 'pending', 'Ticket status changed to pending');

      // Verify in database
      const [row] = await query('SELECT assignee_id, status FROM tickets WHERE id = ?', [unassignedTicket1.id]);
      assert(row.assignee_id === nwAgent.user.id, 'Database reflects updated assignee_id');
      assert(row.status === 'pending', 'Database reflects updated status pending');
    }

    // 10. Attempting to claim an already assigned ticket returns 409 Conflict
    {
      // Northwind Admin attempts to claim already assigned ticket
      const res = await fetch(`${baseUrl}/tickets/${unassignedTicket1.id}/assign`, {
        method: 'PATCH',
        headers: { 'Authorization': `Bearer ${nwAdminToken}` },
      });
      assert(res.status === 409, 'Claiming already assigned ticket returns 409 Conflict');
      const data = await res.json();
      assert(data.error === 'Ticket already assigned', 'Error message indicates conflict');
      assert(data.ticket.assignee_id === nwAgent.user.id, 'Conflict payload contains existing ticket assignee');
    }

    // 11. Admin can assign unassigned ticket to another agent in same organization
    {
      // Create a fresh unassigned ticket in Org 1
      const insertRes = await query(
        'INSERT INTO tickets (org_id, subject, body, status, priority, requester_id) VALUES (?, ?, ?, ?, ?, ?)',
        [1, 'Admin Assignment Test', 'Testing admin delegation', 'open', 'P2', nwRequester.user.id]
      );
      const newTicketId = insertRes.insertId;

      const res = await fetch(`${baseUrl}/tickets/${newTicketId}/assign`, {
        method: 'PATCH',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${nwAdminToken}`,
        },
        body: JSON.stringify({ assigneeId: nwAgent2Id }),
      });
      assert(res.status === 200, 'Admin assigning ticket to another agent returns 200 OK');
      const data = await res.json();
      assert(data.assignee_id === nwAgent2Id, 'Ticket assignee_id matches target agent ID');
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
