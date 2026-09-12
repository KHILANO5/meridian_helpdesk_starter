import express from 'express';
import authRoutes from './src/routes/auth.js';
import ticketRoutes from './src/routes/tickets.js';
import commentRoutes from './src/routes/comments.js';
import { query } from './src/db/pool.js';

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

  console.log('\n--- STARTING VERIFICATION FOR FINDING 5 (INTERNAL NOTES DISCLOSURE) ---\n');

  try {
    // 1. Authenticate users with different roles in Org 1 (Northwind Trading)
    // Admin: Nadia Novak
    const loginAdmin = await fetch(`${baseUrl}/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: 'admin@northwind.test', password: 'Password123!' }),
    });
    const adminData = await loginAdmin.json();
    const adminToken = adminData.token;
    assert(Boolean(adminToken) && adminData.user.role === 'admin', 'Authenticated as Northwind Admin');

    // Agent: Marco Moreau
    const loginAgent = await fetch(`${baseUrl}/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: 'agent1@northwind.test', password: 'Password123!' }),
    });
    const agentData = await loginAgent.json();
    const agentToken = agentData.token;
    assert(Boolean(agentToken) && agentData.user.role === 'agent', 'Authenticated as Northwind Agent');

    // Requester: Ben Brooks
    const loginRequester = await fetch(`${baseUrl}/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: 'user1@northwind.test', password: 'Password123!' }),
    });
    const requesterData = await loginRequester.json();
    const requesterToken = requesterData.token;
    assert(Boolean(requesterToken) && requesterData.user.role === 'requester', 'Authenticated as Northwind Requester');

    // 2. Set up a known test ticket in Org 1 with both public comments and internal agent notes
    const ticketRes = await query(
      'INSERT INTO tickets (org_id, subject, body, status, priority, requester_id) VALUES (?, ?, ?, ?, ?, ?)',
      [1, 'Confidential Staff Note Test Ticket', 'User problem report', 'open', 'P2', requesterData.user.id]
    );
    const testTicketId = ticketRes.insertId;

    // Public comment 1 (by requester)
    await query(
      'INSERT INTO comments (ticket_id, author_id, body, is_internal, created_at) VALUES (?, ?, ?, 0, NOW())',
      [testTicketId, requesterData.user.id, 'Hello, I need help with my invoice!']
    );

    // Internal note 1 (by agent)
    await query(
      'INSERT INTO comments (ticket_id, author_id, body, is_internal, created_at) VALUES (?, ?, ?, 1, NOW())',
      [testTicketId, agentData.user.id, 'INTERNAL NOTE: Customer account has billing dispute, do not refund yet.']
    );

    // Public comment 2 (by agent)
    await query(
      'INSERT INTO comments (ticket_id, author_id, body, is_internal, created_at) VALUES (?, ?, ?, 0, NOW())',
      [testTicketId, agentData.user.id, 'We are looking into this report now.']
    );

    // Internal note 2 (by admin)
    await query(
      'INSERT INTO comments (ticket_id, author_id, body, is_internal, created_at) VALUES (?, ?, ?, 1, NOW())',
      [testTicketId, adminData.user.id, 'INTERNAL NOTE: Escalated to finance director.']
    );

    // 3. Requester fetching ticket does NOT receive internal notes
    {
      const res = await fetch(`${baseUrl}/tickets/${testTicketId}`, {
        headers: { 'Authorization': `Bearer ${requesterToken}` },
      });
      assert(res.status === 200, 'Requester fetching ticket returns 200 OK');
      const data = await res.json();
      assert(Array.isArray(data.comments), 'Response contains comments array');
      assert(data.comments.length === 2, 'Requester receives exactly 2 public comments (internal notes omitted)');

      const hasInternal = data.comments.some(c => c.is_internal === 1 || c.body.includes('INTERNAL NOTE'));
      assert(!hasInternal, 'Requester response contains ZERO internal agent notes or sensitive text');

      const publicBodies = data.comments.map(c => c.body);
      assert(publicBodies.includes('Hello, I need help with my invoice!'), 'Requester receives first public comment');
      assert(publicBodies.includes('We are looking into this report now.'), 'Requester receives second public comment');
    }

    // 4. Agent fetching ticket receives BOTH public comments and internal notes
    {
      const res = await fetch(`${baseUrl}/tickets/${testTicketId}`, {
        headers: { 'Authorization': `Bearer ${agentToken}` },
      });
      assert(res.status === 200, 'Agent fetching ticket returns 200 OK');
      const data = await res.json();
      assert(data.comments.length === 4, 'Agent receives all 4 comments (both public and internal)');

      const internalNotes = data.comments.filter(c => c.is_internal === 1);
      assert(internalNotes.length === 2, 'Agent receives both internal notes');
      assert(
        internalNotes.some(c => c.body.includes('Customer account has billing dispute')),
        'Agent can view internal diagnostic note'
      );
    }

    // 5. Admin fetching ticket receives BOTH public comments and internal notes
    {
      const res = await fetch(`${baseUrl}/tickets/${testTicketId}`, {
        headers: { 'Authorization': `Bearer ${adminToken}` },
      });
      assert(res.status === 200, 'Admin fetching ticket returns 200 OK');
      const data = await res.json();
      assert(data.comments.length === 4, 'Admin receives all 4 comments');
      assert(data.comments.some(c => c.body.includes('Escalated to finance director')), 'Admin can view escalation note');
    }

    // 6. Requester attempting to create an internal note is restricted to public
    {
      const createRes = await fetch(`${baseUrl}/tickets/${testTicketId}/comments`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${requesterToken}`,
        },
        body: JSON.stringify({
          body: 'Requester trying to post as internal note',
          isInternal: true,
        }),
      });
      assert(createRes.status === 201, 'Comment creation returns 201 Created');
      const createdComment = await createRes.json();

      // Check database: is_internal must be 0
      const [dbRow] = await query('SELECT is_internal, body FROM comments WHERE id = ?', [createdComment.id]);
      assert(dbRow.is_internal === 0, 'Requester comment was stored with is_internal = 0 in database');
    }

    // 7. Agent creating internal note succeeds with is_internal = 1
    {
      const createRes = await fetch(`${baseUrl}/tickets/${testTicketId}/comments`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${agentToken}`,
        },
        body: JSON.stringify({
          body: 'Verified agent internal note',
          isInternal: true,
        }),
      });
      assert(createRes.status === 201, 'Agent posting internal note returns 201 Created');
      const createdComment = await createRes.json();

      const [dbRow] = await query('SELECT is_internal FROM comments WHERE id = ?', [createdComment.id]);
      assert(dbRow.is_internal === 1, 'Agent internal note stored with is_internal = 1 in database');
    }

    // 8. Internal notes are not exposed through ticket listing
    {
      const listRes = await fetch(`${baseUrl}/tickets?page=0&search=Confidential%20Staff%20Note`, {
        headers: { 'Authorization': `Bearer ${requesterToken}` },
      });
      const listData = await listRes.json();
      const targetRow = listData.rows.find(r => r.id === testTicketId);
      assert(Boolean(targetRow), 'Test ticket appears in requester ticket list');
      // For requester, comment_count reflects visible comments (3 public comments on this ticket)
      assert(targetRow && targetRow.comment_count === 3, 'Requester comment_count only counts public comments');

      // For agent, comment_count reflects all comments (3 public + 3 internal = 6)
      const agentListRes = await fetch(`${baseUrl}/tickets?page=0&search=Confidential%20Staff%20Note`, {
        headers: { 'Authorization': `Bearer ${agentToken}` },
      });
      const agentListData = await agentListRes.json();
      const agentTargetRow = agentListData.rows.find(r => r.id === testTicketId);
      assert(Boolean(agentTargetRow), 'Test ticket appears in agent ticket list');
      assert(agentTargetRow && agentTargetRow.comment_count === 6, 'Agent comment_count reflects total staff count');
    }

    // 9. Unauthenticated access remains blocked
    {
      const unauthRes = await fetch(`${baseUrl}/tickets/${testTicketId}`);
      assert(unauthRes.status === 401, 'Unauthenticated request to ticket details returns 401 Unauthorized');
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
