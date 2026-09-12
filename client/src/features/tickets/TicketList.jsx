import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { useSelector } from 'react-redux';
import { api } from '../../app/api';

const STATUSES = ['', 'open', 'pending', 'resolved', 'closed'];
const PRIORITIES = ['', 'P1', 'P2', 'P3'];

export default function TicketList() {
  const user = useSelector((s) => s.auth.user);

  const [rows, setRows] = useState([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [search, setSearch] = useState('');
  const [status, setStatus] = useState('');
  const [priority, setPriority] = useState('');
  const [sortBy, setSortBy] = useState('created_at');
  const [order, setOrder] = useState('desc');
  const [breached, setBreached] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);

  useEffect(() => {
    setLoading(true);
    setError(null);
    const params = new URLSearchParams();
    params.set('page', String(page));
    if (search) params.set('search', search);
    if (status) params.set('status', status);
    if (priority) params.set('priority', priority);
    if (sortBy) params.set('sortBy', sortBy);
    if (order) params.set('order', order);
    if (breached) params.set('breached', breached);

    api(`/tickets?${params.toString()}`)
      .then((data) => {
        setRows(data.rows || []);
        setTotal(data.total || 0);
      })
      .catch((err) => {
        setError(err.message || 'Failed to load tickets');
      })
      .finally(() => setLoading(false));
  }, [page, search, status, priority, sortBy, order, breached]);

  function handleSort(field) {
    if (sortBy === field) {
      setOrder((prev) => (prev === 'asc' ? 'desc' : 'asc'));
    } else {
      setSortBy(field);
      setOrder('asc');
    }
    setPage(1);
  }

  function renderSortIndicator(field) {
    if (sortBy !== field) return null;
    return order === 'asc' ? ' ▲' : ' ▼';
  }

  async function handleDelete(id) {
    await api(`/tickets/${id}`, { method: 'DELETE' });
    setRows(rows.filter((r) => r.id !== id));
  }

  const pageCount = Math.ceil(total / 20);

  return (
    <div className="ticket-list">
      <h1>Tickets</h1>

      <div className="filters">
        <input
          placeholder="Search subject…"
          value={search}
          onChange={(e) => {
            setSearch(e.target.value);
            setPage(1);
          }}
        />
        <select
          value={status}
          onChange={(e) => {
            setStatus(e.target.value);
            setPage(1);
          }}
        >
          {STATUSES.map((s) => (
            <option key={s} value={s}>{s ? `Status: ${s}` : 'Any status'}</option>
          ))}
        </select>
        <select
          value={priority}
          onChange={(e) => {
            setPriority(e.target.value);
            setPage(1);
          }}
        >
          {PRIORITIES.map((p) => (
            <option key={p} value={p}>{p ? `Priority: ${p}` : 'Any priority'}</option>
          ))}
        </select>
        <select
          value={sortBy}
          onChange={(e) => {
            setSortBy(e.target.value);
            setPage(1);
          }}
        >
          <option value="created_at">Sort: Created</option>
          <option value="updated_at">Sort: Updated</option>
          <option value="priority">Sort: Priority</option>
          <option value="status">Sort: Status</option>
          <option value="id">Sort: ID</option>
        </select>
        <select
          value={order}
          onChange={(e) => {
            setOrder(e.target.value);
            setPage(1);
          }}
        >
          <option value="desc">Descending</option>
          <option value="asc">Ascending</option>
        </select>
        <select
          aria-label="Filter by SLA status"
          value={breached}
          onChange={(e) => {
            setBreached(e.target.value);
            setPage(1);
          }}
        >
          <option value="">All tickets (SLA)</option>
          <option value="true">Breached tickets</option>
          <option value="false">Non-breached tickets</option>
        </select>
      </div>

      {loading && <p>Loading…</p>}
      {error && <p className="error">{error}</p>}

      <table>
        <thead>
          <tr>
            <th onClick={() => handleSort('id')} style={{ cursor: 'pointer', userSelect: 'none' }}>
              #{renderSortIndicator('id')}
            </th>
            <th>Subject</th>
            <th onClick={() => handleSort('status')} style={{ cursor: 'pointer', userSelect: 'none' }}>
              Status{renderSortIndicator('status')}
            </th>
            <th onClick={() => handleSort('priority')} style={{ cursor: 'pointer', userSelect: 'none' }}>
              Priority{renderSortIndicator('priority')}
            </th>
            <th>Assignee</th>
            <th>Comments</th>
            <th onClick={() => handleSort('created_at')} style={{ cursor: 'pointer', userSelect: 'none' }}>
              Created{renderSortIndicator('created_at')}
            </th>
            <th />
          </tr>
        </thead>
        <tbody>
          {rows.length === 0 && !loading && (
            <tr>
              <td colSpan={8} style={{ textAlign: 'center', padding: '24px', color: '#666' }}>
                No tickets found.
              </td>
            </tr>
          )}
          {rows.map((t) => (
            <tr key={t.id}>
              <td>{t.id}</td>
              <td>
                <Link to={`/tickets/${t.id}`}>{t.subject}</Link>
                {Boolean(t.breached || t.sla?.breached) && (
                  <span className="badge-breached">SLA Breached</span>
                )}
              </td>
              <td>{t.status}</td>
              <td>{t.priority}</td>
              <td>{t.assignee_name || '—'}</td>
              <td>{t.comment_count}</td>
              <td>{new Date(t.created_at).toLocaleString()}</td>
              <td>
                {user?.role === 'admin' && (
                  <button onClick={() => handleDelete(t.id)}>Delete</button>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>

      <div className="pager">
        <button disabled={page <= 1} onClick={() => setPage(page - 1)}>Previous</button>
        <span>Page {page} of {pageCount || 1} · {total} tickets</span>
        <button disabled={page >= pageCount} onClick={() => setPage(page + 1)}>Next</button>
      </div>
    </div>
  );
}
