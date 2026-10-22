const express = require('express');
const { pool } = require('../db/pool');
const { asyncHandler } = require('../utils/asyncHandler');
const { requireAuth } = require('../middleware/auth');
const { addAudit } = require('../utils/audit');
const { serializeMessage } = require('../utils/serialize');

const router = express.Router();
router.use(requireAuth);

async function getUser(userId) {
  const { rows } = await pool.query('SELECT * FROM users WHERE id = $1', [userId]);
  return rows[0];
}

async function findOwned(userId, id) {
  const { rows } = await pool.query('SELECT * FROM messages WHERE id = $1 AND user_id = $2', [id, userId]);
  return rows[0] || null;
}

async function validateBeneficiaryId(userId, beneficiaryId) {
  if (!beneficiaryId) return null;
  const { rows } = await pool.query('SELECT id FROM beneficiaries WHERE id = $1 AND user_id = $2', [
    beneficiaryId,
    userId,
  ]);
  return rows[0] ? beneficiaryId : null;
}

function validateMessageInput(body) {
  const subject = String(body.subject || '').trim();
  const messageBody = String(body.body || '').trim();
  if (!subject) return { error: 'Give the message a subject first.', field: 'subject' };
  if (!body.to) return { error: 'Choose who this message is for.', field: 'to' };
  if (!messageBody) return { error: 'Write the message before scheduling it.', field: 'body' };
  return { subject, body: messageBody, condition: String(body.condition || 'Inactivity period') };
}

router.get(
  '/',
  asyncHandler(async (req, res) => {
    const { rows } = await pool.query('SELECT * FROM messages WHERE user_id = $1 ORDER BY created_at ASC', [
      req.userId,
    ]);
    res.json({ messages: rows.map(serializeMessage) });
  })
);

router.post(
  '/',
  asyncHandler(async (req, res) => {
    const parsed = validateMessageInput(req.body);
    if (parsed.error) return res.status(400).json(parsed);
    const toId = await validateBeneficiaryId(req.userId, req.body.to);
    if (!toId) return res.status(400).json({ error: 'Choose who this message is for.', field: 'to' });

    const { rows } = await pool.query(
      `INSERT INTO messages (user_id, subject, to_beneficiary_id, condition, body, status)
       VALUES ($1, $2, $3, $4, $5, 'Locked') RETURNING *`,
      [req.userId, parsed.subject, toId, parsed.condition, parsed.body]
    );
    const user = await getUser(req.userId);
    await addAudit(req.userId, user.name, 'Scheduled legacy message', parsed.subject, 'success');
    res.status(201).json({ message: serializeMessage(rows[0]) });
  })
);

router.put(
  '/:id',
  asyncHandler(async (req, res) => {
    const existing = await findOwned(req.userId, req.params.id);
    if (!existing) return res.status(404).json({ error: 'Message not found.' });

    const parsed = validateMessageInput(req.body);
    if (parsed.error) return res.status(400).json(parsed);
    const toId = await validateBeneficiaryId(req.userId, req.body.to);
    if (!toId) return res.status(400).json({ error: 'Choose who this message is for.', field: 'to' });

    const { rows } = await pool.query(
      `UPDATE messages SET subject = $1, to_beneficiary_id = $2, condition = $3, body = $4 WHERE id = $5 RETURNING *`,
      [parsed.subject, toId, parsed.condition, parsed.body, req.params.id]
    );
    const user = await getUser(req.userId);
    await addAudit(req.userId, user.name, 'Updated legacy message', parsed.subject, 'info');
    res.json({ message: serializeMessage(rows[0]) });
  })
);

router.delete(
  '/:id',
  asyncHandler(async (req, res) => {
    const existing = await findOwned(req.userId, req.params.id);
    if (!existing) return res.status(404).json({ error: 'Message not found.' });
    await pool.query('DELETE FROM messages WHERE id = $1', [req.params.id]);
    const user = await getUser(req.userId);
    await addAudit(req.userId, user.name, 'Removed legacy message', existing.subject, 'warning');
    res.json({ ok: true });
  })
);

module.exports = router;
