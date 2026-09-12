import express from 'express';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import crypto from 'node:crypto';
import { config } from '../config.js';
import { pool, query } from '../db/pool.js';
import { requireAuth, requireRole } from '../middleware/auth.js';

const router = express.Router();

router.post('/login', async (req, res, next) => {
  try {
    const { email, password } = req.body;
    if (!email || !password) {
      return res.status(400).json({ error: 'email and password are required' });
    }

    const rows = await query('SELECT * FROM users WHERE email = ?', [email]);
    const user = rows[0];
    if (!user) return res.status(401).json({ error: 'Invalid credentials' });

    const ok = await bcrypt.compare(password, user.password_hash);
    if (!ok) return res.status(401).json({ error: 'Invalid credentials' });

    const token = jwt.sign(
      { sub: user.id, orgId: user.org_id, role: user.role },
      config.jwtSecret,
      { expiresIn: config.jwtExpiresIn }
    );

    res.json({
      token,
      user: { id: user.id, name: user.name, email: user.email, role: user.role, orgId: user.org_id },
    });
  } catch (err) {
    next(err);
  }
});

/**
 * Admin creates an invitation for a user in their organization.
 * Generates a cryptographically secure random token and stores only its SHA-256 hash.
 * In production, the raw token should be delivered via email or secure out-of-band channel.
 * For local development and testing, the raw token is returned in the API response.
 */
router.post('/invite', requireAuth, requireRole('admin'), async (req, res, next) => {
  try {
    const { email, name, role, userId } = req.body;
    let targetUser;

    if (userId) {
      const rows = await query('SELECT id, org_id, email, name, role FROM users WHERE id = ?', [userId]);
      targetUser = rows[0];
      if (!targetUser) {
        return res.status(404).json({ error: 'User not found' });
      }
      if (targetUser.org_id !== req.user.orgId) {
        return res.status(403).json({ error: 'Cannot invite user from another organization' });
      }
    } else if (email) {
      if (!name) {
        return res.status(400).json({ error: 'name is required when inviting a new user' });
      }
      const validRoles = ['admin', 'agent', 'requester'];
      const inviteRole = role && validRoles.includes(role) ? role : 'requester';

      const existingRows = await query('SELECT id, org_id, email, name, role FROM users WHERE email = ?', [email]);
      if (existingRows.length > 0) {
        targetUser = existingRows[0];
        if (targetUser.org_id !== req.user.orgId) {
          return res.status(403).json({ error: 'User belongs to another organization' });
        }
      } else {
        const placeholderHash = `!UNSET_${crypto.randomBytes(16).toString('hex')}`;
        const insertResult = await query(
          'INSERT INTO users (org_id, email, password_hash, name, role) VALUES (?, ?, ?, ?, ?)',
          [req.user.orgId, email, placeholderHash, name, inviteRole]
        );
        targetUser = { id: insertResult.insertId, org_id: req.user.orgId, email, name, role: inviteRole };
      }
    } else {
      return res.status(400).json({ error: 'email or userId is required' });
    }

    // Generate cryptographically secure random token
    const rawToken = crypto.randomBytes(32).toString('hex');
    const tokenHash = crypto.createHash('sha256').update(rawToken).digest('hex');

    // Default expiration: 24 hours
    const expiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString().slice(0, 19).replace('T', ' ');

    await query(
      'INSERT INTO invitations (user_id, token_hash, expires_at) VALUES (?, ?, ?)',
      [targetUser.id, tokenHash, expiresAt]
    );

    res.status(201).json({
      ok: true,
      message: 'Invitation created successfully',
      token: rawToken,
      expiresAt,
      user: {
        id: targetUser.id,
        email: targetUser.email,
        name: targetUser.name,
        role: targetUser.role,
        orgId: targetUser.org_id,
      },
    });
  } catch (err) {
    next(err);
  }
});

/**
 * Completes an invitation.
 * Validates the single-use token, ensures it is unused and not expired,
 * and updates the user's password using bcrypt with a cost factor of 10.
 * Operates inside a transaction with row-level locking to prevent race conditions.
 */
router.post('/invite/accept', async (req, res, next) => {
  let conn;
  try {
    const { token, password } = req.body;
    if (!token || typeof token !== 'string' || !password || typeof password !== 'string') {
      return res.status(400).json({ error: 'token and password are required' });
    }

    if (password.length < 8) {
      return res.status(400).json({ error: 'Password must be at least 8 characters long' });
    }

    const tokenHash = crypto.createHash('sha256').update(token).digest('hex');

    conn = await pool.getConnection();
    await conn.beginTransaction();

    // Lock the invitation row for update to prevent concurrent token reuse
    const [rows] = await conn.query(
      `SELECT i.id, i.user_id, i.expires_at, i.used_at, u.org_id
         FROM invitations i
         JOIN users u ON u.id = i.user_id
        WHERE i.token_hash = ?
          AND i.used_at IS NULL
          AND i.expires_at > NOW()
        FOR UPDATE`,
      [tokenHash]
    );

    const invitation = rows[0];
    if (!invitation) {
      await conn.rollback();
      return res.status(400).json({ error: 'Invalid or expired invitation token' });
    }

    // Hash the password using bcrypt with cost factor 10 (matching project convention)
    const passwordHash = await bcrypt.hash(password, 10);

    // Update the user's password
    await conn.query('UPDATE users SET password_hash = ? WHERE id = ?', [passwordHash, invitation.user_id]);

    // Mark the invitation as used
    await conn.query('UPDATE invitations SET used_at = NOW() WHERE id = ?', [invitation.id]);

    await conn.commit();

    res.json({ ok: true, message: 'Password set successfully' });
  } catch (err) {
    if (conn) {
      try {
        await conn.rollback();
      } catch (rbErr) {
        console.error('Rollback error:', rbErr);
      }
    }
    next(err);
  } finally {
    if (conn) {
      conn.release();
    }
  }
});

export default router;
