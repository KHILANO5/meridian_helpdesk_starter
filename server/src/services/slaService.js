import { config } from '../config.js';

/**
 * Calculates the SLA state for a ticket based on priority and created_at.
 *
 * @param {Object} ticket - Ticket data
 * @param {string} [ticket.priority] - 'P1' | 'P2' | 'P3'
 * @param {string|Date} [ticket.created_at] - Creation timestamp
 * @param {number|Date} [now] - Optional reference timestamp (defaults to Date.now())
 * @returns {Object} SLA status object
 */
export function calculateSla(ticket, now = Date.now()) {
  const rawPriority = ticket?.priority ? String(ticket.priority).toUpperCase() : null;
  const targetHours = rawPriority && config.slaTargets ? config.slaTargets[rawPriority] : null;

  if (!targetHours || typeof targetHours !== 'number') {
    return {
      priority: null,
      targetHours: null,
      deadline: null,
      breached: false,
      status: 'unknown',
    };
  }

  const createdAt = ticket?.created_at ? new Date(ticket.created_at) : null;
  if (!createdAt || isNaN(createdAt.getTime())) {
    return {
      priority: null,
      targetHours: null,
      deadline: null,
      breached: false,
      status: 'unknown',
    };
  }

  const deadlineTime = createdAt.getTime() + targetHours * 3600 * 1000;
  const deadline = new Date(deadlineTime).toISOString();
  const currentTime = typeof now === 'number' ? now : (now instanceof Date ? now.getTime() : Date.now());
  const breached = currentTime > deadlineTime;

  return {
    priority: rawPriority,
    targetHours,
    deadline,
    breached,
  };
}
