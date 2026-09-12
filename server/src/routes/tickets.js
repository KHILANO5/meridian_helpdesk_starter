import express from 'express';
import { requireAuth, requireRole } from '../middleware/auth.js';
import {
  listTickets,
  getTicketById,
  createTicket,
  assignTicket,
  deleteTicket,
  listComments,
} from '../services/ticketService.js';

const router = express.Router();

router.get('/', requireAuth, async (req, res, next) => {
  try {
    const result = await listTickets({
      orgId: req.user.orgId,
      role: req.user.role,
      page: Number(req.query.page || 1),
      search: req.query.search || '',
      status: req.query.status,
      priority: req.query.priority,
      sortBy: req.query.sortBy || 'created_at',
      order: req.query.order || 'desc',
    });
    res.json(result);
  } catch (err) {
    next(err);
  }
});

router.get('/:id', requireAuth, async (req, res, next) => {
  try {
    const ticketId = Number(req.params.id);
    if (!Number.isInteger(ticketId) || ticketId <= 0) {
      return res.status(404).json({ error: 'Not found' });
    }

    const ticket = await getTicketById(ticketId, req.user.orgId);
    if (!ticket) return res.status(404).json({ error: 'Not found' });

    const isStaff = req.user.role === 'agent' || req.user.role === 'admin';
    const comments = await listComments(ticket.id, isStaff);
    res.json({ ticket, comments });
  } catch (err) {
    next(err);
  }
});

router.post('/', requireAuth, async (req, res, next) => {
  try {
    const { subject, body, priority } = req.body;
    if (!subject || !body) {
      return res.status(400).json({ error: 'subject and body are required' });
    }
    const ticket = await createTicket({
      orgId: req.user.orgId,
      subject,
      body,
      priority: priority || 'P3',
      requesterId: req.user.id,
    });
    res.status(201).json(ticket);
  } catch (err) {
    next(err);
  }
});

router.patch('/:id/assign', requireAuth, requireRole('agent', 'admin'), async (req, res, next) => {
  try {
    const ticketId = Number(req.params.id);
    if (!Number.isInteger(ticketId) || ticketId <= 0) {
      return res.status(404).json({ error: 'Not found' });
    }

    const assigneeId = req.body?.assigneeId !== undefined ? Number(req.body.assigneeId) : req.user.id;
    if (!Number.isInteger(assigneeId) || assigneeId <= 0) {
      return res.status(400).json({ error: 'Invalid assignee ID' });
    }

    const result = await assignTicket(ticketId, assigneeId, req.user.orgId);
    if (!result) return res.status(404).json({ error: 'Not found' });
    if (result.invalidAssignee) {
      return res.status(400).json({ error: 'Assignee must be an agent or admin in the same organization' });
    }
    if (result.conflict) {
      return res.status(409).json({ error: 'Ticket already assigned', ticket: result.ticket });
    }
    res.json(result.ticket);
  } catch (err) {
    next(err);
  }
});

router.delete('/:id', requireAuth, async (req, res, next) => {
  try {
    const ticket = await getTicketById(Number(req.params.id));
    if (!ticket) return res.status(404).json({ error: 'Not found' });
    await deleteTicket(ticket.id);
    res.status(204).end();
  } catch (err) {
    next(err);
  }
});

export default router;
