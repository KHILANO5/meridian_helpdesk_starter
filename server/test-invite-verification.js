import express from 'express';
import bcrypt from 'bcryptjs';
import crypto from 'node:crypto';
import authRoutes from './src/routes/auth.js';
import { query } from './src/db/pool.js';

const app = express();
app.use(express.json());
app.use('/api/auth', authRoutes);

async function runTests() {
  const server = app.listen(0);
  const port = server.address().port;
  const baseUrl = `http://localhost:${port}/api/auth`;

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

  console.log('\n--- STARTING VERIFICATION FOR FINDING 1 ---\n');

  try {
    // 1. Old arbitrary-userId password-reset attack fails
    {
      const [origUser] = await query('SELECT password_hash FROM users WHERE id = 1');
      const res = await fetch(`${baseUrl}/invite/accept`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ userId: 1, password: 'AttackerPassword123!' }),
      });
      const data = await res.json();
      const [afterUser] = await query('SELECT password_hash FROM users WHERE id = 1');
      assert(res.status === 400, 'Old arbitrary-userId attack is rejected with 400');
      assert(origUser.password_hash === afterUser.password_hash, 'Target user password_hash was untouched by old attack payload');
    }

    // 2. Missing token is rejected
    {
      const res = await fetch(`${baseUrl}/invite/accept`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ password: 'ValidPassword123!' }),
      });
      assert(res.status === 400, 'Missing token is rejected with 400');
    }

    // 3. Short / invalid password is rejected
    {
      const res = await fetch(`${baseUrl}/invite/accept`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ token: 'sometoken', password: 'short' }),
      });
      assert(res.status === 400, 'Password under 8 characters is rejected with 400');
    }

    // 4. Invalid token is rejected
    {
      const res = await fetch(`${baseUrl}/invite/accept`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ token: 'totally_invalid_nonexistent_token', password: 'ValidPassword123!' }),
      });
      assert(res.status === 400, 'Invalid / nonexistent token is rejected with 400');
    }

    // 5. Non-admin user cannot create invitations
    let adminToken, agentToken;
    {
      // Log in as admin
      const adminLogin = await fetch(`${baseUrl}/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: 'admin@northwind.test', password: 'Password123!' }),
      });
      const adminData = await adminLogin.json();
      adminToken = adminData.token;

      // Log in as agent
      const agentLogin = await fetch(`${baseUrl}/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: 'agent1@northwind.test', password: 'Password123!' }),
      });
      const agentData = await agentLogin.json();
      agentToken = agentData.token;

      const nonAdminRes = await fetch(`${baseUrl}/invite`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${agentToken}`,
        },
        body: JSON.stringify({ email: 'newjoiner@northwind.test', name: 'New Joiner' }),
      });
      assert(nonAdminRes.status === 403, 'Non-admin agent cannot create invitations (403 Forbidden)');
    }

    // 6. Admin cannot create invitation for another organization's user
    {
      // Cobalt admin is org 2, user1@cobalt.test is org 2 user
      const [cobaltUser] = await query('SELECT id FROM users WHERE email = "user1@cobalt.test"');
      const crossOrgRes = await fetch(`${baseUrl}/invite`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${adminToken}`, // Northwind admin (org 1)
        },
        body: JSON.stringify({ userId: cobaltUser.id }),
      });
      assert(crossOrgRes.status === 403, 'Admin cannot invite a user from another organization (403 Forbidden)');
    }

    // 7. Admin can successfully create invitation for their organization
    let validToken, invitedUserId;
    {
      const inviteRes = await fetch(`${baseUrl}/invite`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${adminToken}`,
        },
        body: JSON.stringify({
          email: 'verified_invitee@northwind.test',
          name: 'Verified Invitee',
          role: 'agent',
        }),
      });
      assert(inviteRes.status === 201, 'Admin can create invitation (201 Created)');
      const inviteData = await inviteRes.json();
      validToken = inviteData.token;
      invitedUserId = inviteData.user.id;
      assert(Boolean(validToken) && validToken.length === 64, 'Generated token is a 64-char hex string');

      // Check DB: token hash stored, raw token is NOT in DB
      const [dbRow] = await query('SELECT * FROM invitations WHERE user_id = ? ORDER BY id DESC LIMIT 1', [invitedUserId]);
      assert(Boolean(dbRow), 'Invitation record saved in database');
      assert(dbRow.token_hash !== validToken, 'Database stores token_hash, not the raw token');
      const expectedHash = crypto.createHash('sha256').update(validToken).digest('hex');
      assert(dbRow.token_hash === expectedHash, 'Database token_hash matches SHA-256 of raw token');
    }

    // 8. Expired token is rejected
    {
      const expiredRawToken = crypto.randomBytes(32).toString('hex');
      const expiredHash = crypto.createHash('sha256').update(expiredRawToken).digest('hex');
      const pastTime = new Date(Date.now() - 3600000).toISOString().slice(0, 19).replace('T', ' ');
      await query(
        'INSERT INTO invitations (user_id, token_hash, expires_at) VALUES (?, ?, ?)',
        [invitedUserId, expiredHash, pastTime]
      );
      const expiredRes = await fetch(`${baseUrl}/invite/accept`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ token: expiredRawToken, password: 'NewSecurePassword123!' }),
      });
      assert(expiredRes.status === 400, 'Expired invitation token is rejected with 400');
    }

    // 9. Successfully accept invitation
    {
      const acceptRes = await fetch(`${baseUrl}/invite/accept`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ token: validToken, password: 'NewSecurePassword123!' }),
      });
      assert(acceptRes.status === 200, 'Valid invitation token is accepted with 200 OK');

      // Check user password in DB: must be bcrypt hash, never plaintext
      const [updatedUser] = await query('SELECT password_hash FROM users WHERE id = ?', [invitedUserId]);
      assert(updatedUser.password_hash !== 'NewSecurePassword123!', 'Password is NOT stored as plaintext');
      assert(updatedUser.password_hash.startsWith('$2a$') || updatedUser.password_hash.startsWith('$2b$'), 'Password is stored as bcrypt hash');
      const bcryptMatch = await bcrypt.compare('NewSecurePassword123!', updatedUser.password_hash);
      assert(bcryptMatch === true, 'bcrypt.compare succeeds with the newly set password');

      // Check invitation status: used_at is populated
      const [inviteRow] = await query('SELECT used_at FROM invitations WHERE user_id = ? AND token_hash = ?', [
        invitedUserId,
        crypto.createHash('sha256').update(validToken).digest('hex'),
      ]);
      assert(inviteRow.used_at !== null, 'Invitation is marked as used (used_at is not null)');
    }

    // 10. Reusing the same token is rejected
    {
      const reuseRes = await fetch(`${baseUrl}/invite/accept`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ token: validToken, password: 'AnotherPassword123!' }),
      });
      assert(reuseRes.status === 400, 'Reusing a consumed token is rejected with 400');
    }

    // 11. New password works with the standard login route
    {
      const loginRes = await fetch(`${baseUrl}/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: 'verified_invitee@northwind.test', password: 'NewSecurePassword123!' }),
      });
      assert(loginRes.status === 200, 'New user can successfully log in with the new password');
      const loginData = await loginRes.json();
      assert(Boolean(loginData.token), 'Login returns valid JWT token');
      assert(loginData.user.id === invitedUserId, 'Logged in user ID matches invited user ID');
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
