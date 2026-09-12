import { pool, query } from '../db/pool.js';
import { config } from '../config.js';
import { calculateSla } from './slaService.js';

export { calculateSla };

const PAGE_SIZE = 20;

const SORT_FIELDS = {
  created_at: 't.created_at',
  createdAt: 't.created_at',
  updated_at: 't.updated_at',
  updatedAt: 't.updated_at',
  priority: 't.priority',
  status: 't.status',
  id: 't.id',
};

const SORT_ORDERS = {
  asc: 'ASC',
  desc: 'DESC',
};

/**
 * Paginated ticket list for the current organisation.
 *
 * Supports free-text search on subject, filtering by status and priority,
 * and sorting by any column the UI exposes in its dropdown.
 */
export async function listTickets({ orgId, role, page = 1, search = '', status, priority, sortBy = 'created_at', order = 'desc', breached }) {
  const where = ['t.org_id = ?'];
  const params = [orgId];

  if (search) {
    where.push('t.subject LIKE ?');
    params.push(`%${search}%`);
  }
  if (status) {
    where.push('t.status = ?');
    params.push(status);
  }
  if (priority) {
    where.push('t.priority = ?');
    params.push(priority);
  }
  if (breached === true || breached === 'true' || breached === '1') {
    where.push(
      `NOW() > DATE_ADD(t.created_at, INTERVAL (CASE t.priority WHEN 'P1' THEN ? WHEN 'P2' THEN ? WHEN 'P3' THEN ? END) HOUR)`
    );
    params.push(config.slaTargets.P1, config.slaTargets.P2, config.slaTargets.P3);
  } else if (breached === false || breached === 'false' || breached === '0') {
    where.push(
      `NOW() <= DATE_ADD(t.created_at, INTERVAL (CASE t.priority WHEN 'P1' THEN ? WHEN 'P2' THEN ? WHEN 'P3' THEN ? END) HOUR)`
    );
    params.push(config.slaTargets.P1, config.slaTargets.P2, config.slaTargets.P3);
  }

  const whereSql = where.join(' AND ');
  const offset = page * PAGE_SIZE;

  // Strict allowlist validation and safe defaults to eliminate SQL injection
  const safeSortField = SORT_FIELDS[sortBy] || 't.created_at';
  const safeOrder = SORT_ORDERS[String(order).toLowerCase()] || 'DESC';

  const rows = await query(
    `SELECT t.id, t.subject, t.status, t.priority, t.created_at, t.updated_at,
            t.assignee_id, u.name AS assignee_name, r.name AS requester_name
       FROM tickets t
       LEFT JOIN users u ON u.id = t.assignee_id
       JOIN users r ON r.id = t.requester_id
      WHERE ${whereSql}
      ORDER BY ${safeSortField} ${safeOrder}
      LIMIT ? OFFSET ?`,
    [...params, PAGE_SIZE, offset]
  );

  // Attach comment count and calculated SLA state for each row
  const isStaff = role === 'agent' || role === 'admin';
  for (const row of rows) {
    const countSql = isStaff
      ? 'SELECT COUNT(*) AS c FROM comments WHERE ticket_id = ?'
      : 'SELECT COUNT(*) AS c FROM comments WHERE ticket_id = ? AND is_internal = 0';
    const [{ c }] = await query(countSql, [row.id]);
    row.comment_count = c;

    // Attach SLA calculation
    row.sla = calculateSla(row);
    row.breached = row.sla.breached;
  }

  const [{ total }] = await query(
    `SELECT COUNT(*) AS total FROM tickets t WHERE ${whereSql}`,
    params
  );

  return { rows, total, page, pageSize: PAGE_SIZE };
}

export async function getTicketById(id, orgId) {
  const where = ['t.id = ?'];
  const params = [id];

  if (orgId !== undefined && orgId !== null) {
    where.push('t.org_id = ?');
    params.push(orgId);
  }

  const rows = await query(
    `SELECT t.*, u.name AS assignee_name, r.name AS requester_name, r.email AS requester_email
       FROM tickets t
       LEFT JOIN users u ON u.id = t.assignee_id
       JOIN users r ON r.id = t.requester_id
      WHERE ${where.join(' AND ')}`,
    params
  );
  const ticket = rows[0] || null;
  if (ticket) {
    ticket.sla = calculateSla(ticket);
    ticket.breached = ticket.sla.breached;
  }
  return ticket;
}

export async function listComments(ticketId, includeInternal = false) {
  const where = ['c.ticket_id = ?'];
  const params = [ticketId];

  if (!includeInternal) {
    where.push('c.is_internal = 0');
  }

  return query(
    `SELECT c.id, c.body, c.is_internal, c.created_at, u.name AS author_name, u.role AS author_role
       FROM comments c
       JOIN users u ON u.id = c.author_id
      WHERE ${where.join(' AND ')}
      ORDER BY c.created_at ASC`,
    params
  );
}

export async function createTicket({ orgId, subject, body, priority, requesterId }) {
  const result = await query(
    `INSERT INTO tickets (org_id, subject, body, priority, requester_id)
     VALUES (?, ?, ?, ?, ?)`,
    [orgId, subject, body, priority, requesterId]
  );
  return getTicketById(result.insertId);
}

export async function assignTicket(ticketId, assigneeId, orgId) {
  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();

    // Lock ticket row FOR UPDATE scoped to the organization
    const [rows] = await conn.query(
      'SELECT * FROM tickets WHERE id = ? AND org_id = ? FOR UPDATE',
      [ticketId, orgId]
    );
    const ticket = rows[0];
    if (!ticket) {
      await conn.rollback();
      return null;
    }

    // Check if already assigned
    if (ticket.assignee_id) {
      await conn.rollback();
      const currentTicket = await getTicketById(ticketId, orgId);
      return { conflict: true, ticket: currentTicket };
    }

    // Validate that assignee belongs to the same organization and has agent/admin role
    const [userRows] = await conn.query(
      'SELECT id, name, role, org_id FROM users WHERE id = ?',
      [assigneeId]
    );
    const agent = userRows[0];
    if (!agent || agent.org_id !== orgId || (agent.role !== 'agent' && agent.role !== 'admin')) {
      await conn.rollback();
      return { invalidAssignee: true };
    }

    // Atomically assign ticket and transition status to pending
    await conn.query(
      'UPDATE tickets SET assignee_id = ?, status = ? WHERE id = ? AND org_id = ?',
      [assigneeId, 'pending', ticketId, orgId]
    );

    await conn.commit();

    const updatedTicket = await getTicketById(ticketId, orgId);
    return { conflict: false, assignedTo: agent, ticket: updatedTicket };
  } catch (err) {
    await conn.rollback();
    throw err;
  } finally {
    conn.release();
  }
}

export async function deleteTicket(id) {
  await query('DELETE FROM tickets WHERE id = ?', [id]);
}
