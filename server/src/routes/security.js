const express = require('express');
const { pool } = require('../db/pool');
const { asyncHandler } = require('../utils/asyncHandler');
const { requireAuth } = require('../middleware/auth');
const { addAudit } = require('../utils/audit');
const { serializeSecurity, serializeSession } = require('../utils/serialize');

const router = express.Router();
router.use(requireAuth);

async function findUserById(id) {
  const { rows } = await pool.query('SELECT * FROM users WHERE id = $1', [id]);
  return rows[0] || null;
}

const TOGGLE_FIELDS = {
  alerts: { column: 'login_alerts_enabled', label: 'login alerts' },
  bio: { column: 'biometric_enabled', label: 'biometric unlock' },
};

// Toggle login alerts / biometric unlock (2FA has its own OTP-backed routes
// under /api/auth/2fa/*).
router.post(
  '/toggle',
  asyncHandler(async (req, res) => {
    const { key } = req.body;
    const field = TOGGLE_FIELDS[key];
    if (!field) return res.status(400).json({ error: 'Unknown security setting.' });

    const user = await findUserById(req.userId);
    const nextValue = !user[field.column];
    await pool.query(`UPDATE users SET ${field.column} = $1 WHERE id = $2`, [nextValue, req.userId]);
    await addAudit(
      req.userId,
      user.name,
      (nextValue ? 'Enabled ' : 'Disabled ') + field.label,
      'Security setting changed',
      nextValue ? 'success' : 'warning'
    );
    const fresh = await findUserById(req.userId);
    res.json({ security: serializeSecurity(fresh) });
  })
);

router.put(
  '/inactivity-days',
  asyncHandler(async (req, res) => {
    const days = Number(req.body.days);
    if (!Number.isFinite(days) || days < 30 || days > 365) {
      return res.status(400).json({ error: 'Inactivity trigger must be between 30 and 365 days.' });
    }
    const user = await findUserById(req.userId);
    await pool.query('UPDATE users SET inactivity_days = $1 WHERE id = $2', [days, req.userId]);
    await addAudit(req.userId, user.name, 'Updated inactivity trigger', `Set to ${days} days`, 'info');
    const fresh = await findUserById(req.userId);
    res.json({ security: serializeSecurity(fresh) });
  })
);

router.get(
  '/sessions',
  asyncHandler(async (req, res) => {
    const { rows } = await pool.query('SELECT * FROM sessions WHERE user_id = $1 ORDER BY created_at DESC', [
      req.userId,
    ]);
    res.json({ sessions: rows.map((r) => serializeSession(r, req.sessionId)) });
  })
);

router.delete(
  '/sessions/:id',
  asyncHandler(async (req, res) => {
    if (req.params.id === req.sessionId) {
      return res.status(400).json({ error: 'Use "Log out" to end your own current session.' });
    }
    const user = await findUserById(req.userId);
    const { rowCount } = await pool.query('DELETE FROM sessions WHERE id = $1 AND user_id = $2', [
      req.params.id,
      req.userId,
    ]);
    if (!rowCount) return res.status(404).json({ error: 'Session not found.' });
    await addAudit(req.userId, user.name, 'Signed out session', req.params.id, 'info');
    res.json({ ok: true });
  })
);

module.exports = router;
