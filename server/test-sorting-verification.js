import express from 'express';
import authRoutes from './src/routes/auth.js';
import ticketRoutes from './src/routes/tickets.js';
import { listTickets } from './src/services/ticketService.js';

const app = express();
app.use(express.json());
app.use('/api/auth', authRoutes);
app.use('/api/tickets', ticketRoutes);

// Global error handler to catch any 500s or database errors
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

  console.log('\n--- STARTING VERIFICATION FOR FINDING 2 (SORT SQL INJECTION) ---\n');

  try {
    // Obtain valid auth token for an existing user (Northwind user)
    const loginRes = await fetch(`${baseUrl}/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: 'user1@northwind.test', password: 'Password123!' }),
    });
    const loginData = await loginRes.json();
    const token = loginData.token;
    assert(Boolean(token), 'Authenticated successfully to obtain JWT');

    const authHeaders = {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${token}`,
    };

    // 1. Default sorting works
    {
      const res = await fetch(`${baseUrl}/tickets`, { headers: authHeaders });
      const data = await res.json();
      assert(res.status === 200, 'Default sorting returns 200 OK');
      assert(Array.isArray(data.rows) && data.rows.length > 0, 'Default sorting returns ticket rows');
    }

    // 2. Each allowed sort field works
    const allowedFields = ['created_at', 'updated_at', 'priority', 'status', 'id', 'createdAt', 'updatedAt'];
    for (const field of allowedFields) {
      const res = await fetch(`${baseUrl}/tickets?sortBy=${field}`, { headers: authHeaders });
      const data = await res.json();
      assert(res.status === 200, `Allowed sort field '${field}' returns 200 OK`);
      assert(Array.isArray(data.rows), `Allowed sort field '${field}' returns rows array`);
    }

    // 3. Both asc and desc work
    {
      const resAsc = await fetch(`${baseUrl}/tickets?sortBy=created_at&order=asc`, { headers: authHeaders });
      const dataAsc = await resAsc.json();
      assert(resAsc.status === 200, 'Sort order=asc returns 200 OK');

      const resDesc = await fetch(`${baseUrl}/tickets?sortBy=created_at&order=desc`, { headers: authHeaders });
      const dataDesc = await resDesc.json();
      assert(resDesc.status === 200, 'Sort order=desc returns 200 OK');

      // Verify asc vs desc ordering difference
      if (dataAsc.rows.length > 1 && dataDesc.rows.length > 1) {
        const firstAscDate = new Date(dataAsc.rows[0].created_at).getTime();
        const lastAscDate = new Date(dataAsc.rows[dataAsc.rows.length - 1].created_at).getTime();
        assert(firstAscDate <= lastAscDate, 'order=asc correctly sorts rows in ascending chronological order');
      }
    }

    // 4. Invalid sortBy is safely replaced with default
    {
      const res = await fetch(`${baseUrl}/tickets?sortBy=unknown_field`, { headers: authHeaders });
      const data = await res.json();
      assert(res.status === 200, 'Invalid sortBy=unknown_field returns 200 OK with safe fallback');
      assert(Array.isArray(data.rows) && data.rows.length > 0, 'Invalid sortBy produces valid rows without crashing');
    }

    // 5. Invalid order is safely replaced with default
    {
      const res = await fetch(`${baseUrl}/tickets?order=sideways`, { headers: authHeaders });
      const data = await res.json();
      assert(res.status === 200, 'Invalid order=sideways returns 200 OK with safe fallback');
      assert(Array.isArray(data.rows) && data.rows.length > 0, 'Invalid order produces valid rows without crashing');
    }

    // 6. Harmless SQL-injection-like sortBy value does not alter the query
    {
      const res = await fetch(`${baseUrl}/tickets?sortBy=created_at,%20id`, { headers: authHeaders });
      const data = await res.json();
      assert(res.status === 200, 'Harmless injected sortBy "created_at, id" is safely sanitized and returns 200 OK');
      assert(Array.isArray(data.rows) && data.rows.length > 0, 'Harmless injected sortBy does not corrupt SQL query');
    }

    // 7. Harmless SQL-injection-like order value does not alter the query
    {
      const res = await fetch(`${baseUrl}/tickets?order=desc,%20id`, { headers: authHeaders });
      const data = await res.json();
      assert(res.status === 200, 'Harmless injected order "desc, id" is safely sanitized and returns 200 OK');
      assert(Array.isArray(data.rows) && data.rows.length > 0, 'Harmless injected order does not corrupt SQL query');
    }

    // 8. Normal ticket filtering and pagination still work
    {
      const resFilter = await fetch(`${baseUrl}/tickets?status=open&priority=P1`, { headers: authHeaders });
      const dataFilter = await resFilter.json();
      assert(resFilter.status === 200, 'Filtering with status=open&priority=P1 returns 200 OK');
      const allMatch = dataFilter.rows.every(t => t.status === 'open' && t.priority === 'P1');
      assert(allMatch, 'All returned tickets match the requested status and priority filters');

      const resPage = await fetch(`${baseUrl}/tickets?page=1`, { headers: authHeaders });
      const dataPage = await resPage.json();
      assert(resPage.status === 200, 'Pagination page=1 query returns 200 OK');
      assert(dataPage.page === 1, 'Pagination response contains correct page number');
    }

    // 9. No SQL error or stack trace is exposed to the client
    {
      const attackParams = [
        'sortBy=--%20comment',
        'sortBy=1;SELECT%201',
        'order=ASC;--%20test',
        'sortBy=users.name',
      ];
      for (const param of attackParams) {
        const res = await fetch(`${baseUrl}/tickets?${param}`, { headers: authHeaders });
        const data = await res.json();
        assert(res.status === 200, `Payload '${param}' safely handled with 200 OK (no SQL error)`);
        assert(!data.error, `Payload '${param}' did not trigger an error message`);
        assert(!data.details, `Payload '${param}' did not expose database stack trace`);
      }
    }

    // 10. Direct service function verification
    {
      const serviceResult = await listTickets({
        orgId: 1,
        sortBy: 'malicious_input_or_invalid',
        order: 'invalid_order',
      });
      assert(Array.isArray(serviceResult.rows), 'Direct listTickets call with invalid sort safely executes and returns rows');
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
