const express = require('express');
const { pool } = require('../db/pool');
const { asyncHandler } = require('../utils/asyncHandler');
const { requireAuth } = require('../middleware/auth');
const { addAudit } = require('../utils/audit');
const { serializeInstruction, serializeSecurity } = require('../utils/serialize');

const router = express.Router();
router.use(requireAuth);

const NEEDS_BENEFICIARY = ['Manual release by executor', 'Verified death certificate'];

async function getUser(userId) {
  const { rows } = await pool.query('SELECT * FROM users WHERE id = $1', [userId]);
  return rows[0];
}

async function findOwned(userId, id) {
  const { rows } = await pool.query('SELECT * FROM instructions WHERE id = $1 AND user_id = $2', [id, userId]);
  return rows[0] || null;
}

async function validateBeneficiaryId(userId, beneficiaryId) {
  if (!beneficiaryId) return null;
  const { rows } = await pool.query('SELECT id, name, relationship FROM beneficiaries WHERE id = $1 AND user_id = $2', [
    beneficiaryId,
    userId,
  ]);
  return rows[0] || null;
}

function validateInstructionInput(body) {
  const title = String(body.title || '').trim();
  const trigger = String(body.trigger || '').trim();
  if (!title) return { error: 'Give the instruction a title first.', field: 'title' };
  return { title, trigger, details: String(body.details || '').trim() };
}

router.get(
  '/',
  asyncHandler(async (req, res) => {
    const { rows } = await pool.query('SELECT * FROM instructions WHERE user_id = $1 ORDER BY created_at ASC', [
      req.userId,
    ]);
    res.json({ instructions: rows.map(serializeInstruction) });
  })
);

router.post(
  '/',
  asyncHandler(async (req, res) => {
    const parsed = validateInstructionInput(req.body);
    if (parsed.error) return res.status(400).json(parsed);

    const beneficiary = await validateBeneficiaryId(req.userId, req.body.beneficiaryId);
    if (!beneficiary && NEEDS_BENEFICIARY.includes(parsed.trigger)) {
      return res.status(400).json({ error: 'This trigger needs a beneficiary assigned to release to.', field: 'beneficiaryId' });
    }
    const status = ['Draft', 'Active', 'Fulfilled'].includes(req.body.status) ? req.body.status : 'Draft';

    const { rows } = await pool.query(
      `INSERT INTO instructions (user_id, title, trigger_condition, beneficiary_id, details, status)
       VALUES ($1, $2, $3, $4, $5, $6) RETURNING *`,
      [req.userId, parsed.title, parsed.trigger, beneficiary ? beneficiary.id : null, parsed.details, status]
    );
    const user = await getUser(req.userId);
    await addAudit(req.userId, user.name, 'Created instruction', parsed.title, 'success');
    res.status(201).json({ instruction: serializeInstruction(rows[0]) });
  })
);

router.put(
  '/:id',
  asyncHandler(async (req, res) => {
    const existing = await findOwned(req.userId, req.params.id);
    if (!existing) return res.status(404).json({ error: 'Instruction not found.' });

    const parsed = validateInstructionInput(req.body);
    if (parsed.error) return res.status(400).json(parsed);

    const beneficiary = await validateBeneficiaryId(req.userId, req.body.beneficiaryId);
    if (!beneficiary && NEEDS_BENEFICIARY.includes(parsed.trigger)) {
      return res.status(400).json({ error: 'This trigger needs a beneficiary assigned to release to.', field: 'beneficiaryId' });
    }
    const status = ['Draft', 'Active', 'Fulfilled'].includes(req.body.status) ? req.body.status : existing.status;

    const triggerChanged = existing.trigger_condition !== parsed.trigger;
    const verificationStatus = triggerChanged ? 'not_started' : existing.verification_status;
    const verificationRef = triggerChanged ? null : existing.verification_ref;
    const verificationSimulatedDays = triggerChanged ? 0 : existing.verification_simulated_days;

    const { rows } = await pool.query(
      `UPDATE instructions
       SET title = $1, trigger_condition = $2, beneficiary_id = $3, details = $4, status = $5,
           verification_status = $6, verification_ref = $7, verification_simulated_days = $8
       WHERE id = $9 RETURNING *`,
      [
        parsed.title,
        parsed.trigger,
        beneficiary ? beneficiary.id : null,
        parsed.details,
        status,
        verificationStatus,
        verificationRef,
        verificationSimulatedDays,
        req.params.id,
      ]
    );
    const user = await getUser(req.userId);
    await addAudit(req.userId, user.name, 'Updated instruction', parsed.title, 'info');
    res.json({ instruction: serializeInstruction(rows[0]) });
  })
);

router.delete(
  '/:id',
  asyncHandler(async (req, res) => {
    const existing = await findOwned(req.userId, req.params.id);
    if (!existing) return res.status(404).json({ error: 'Instruction not found.' });
    await pool.query('DELETE FROM instructions WHERE id = $1', [req.params.id]);
    const user = await getUser(req.userId);
    await addAudit(req.userId, user.name, 'Removed instruction', existing.title, 'warning');
    res.json({ ok: true });
  })
);

// ---------- trigger verification actions ----------
router.post(
  '/:id/request-verification',
  asyncHandler(async (req, res) => {
    const existing = await findOwned(req.userId, req.params.id);
    if (!existing) return res.status(404).json({ error: 'Instruction not found.' });
    const user = await getUser(req.userId);

    let ref = existing.verification_ref;
    if (existing.trigger_condition === 'Verified death certificate') {
      ref = `DC-${new Date().getFullYear()}-${Math.floor(1000 + Math.random() * 9000)}`;
      await addAudit(req.userId, user.name, 'Certificate verification requested', `${existing.title} · ref ${ref}`, 'info');
    } else {
      let benefName = '';
      if (existing.beneficiary_id) {
        const { rows } = await pool.query('SELECT name FROM beneficiaries WHERE id = $1', [existing.beneficiary_id]);
        if (rows[0]) benefName = ' · ' + rows[0].name;
      }
      await addAudit(req.userId, user.name, 'Executor approval requested', existing.title + benefName, 'info');
    }

    const { rows } = await pool.query(
      `UPDATE instructions SET verification_status = 'pending', verification_ref = $1 WHERE id = $2 RETURNING *`,
      [ref, req.params.id]
    );
    res.json({ instruction: serializeInstruction(rows[0]) });
  })
);

router.post(
  '/:id/resolve',
  asyncHandler(async (req, res) => {
    const existing = await findOwned(req.userId, req.params.id);
    if (!existing) return res.status(404).json({ error: 'Instruction not found.' });
    const approved = !!req.body.approved;
    const user = await getUser(req.userId);

    const { rows } = await pool.query(
      `UPDATE instructions SET verification_status = $1, status = $2 WHERE id = $3 RETURNING *`,
      [approved ? 'approved' : 'rejected', approved ? 'Fulfilled' : existing.status, req.params.id]
    );
    if (approved) {
      await addAudit(req.userId, user.name, 'Instruction fulfilled', `${existing.title} · trigger verified`, 'success');
    } else {
      await addAudit(req.userId, user.name, 'Instruction verification rejected', existing.title, 'warning');
    }
    res.json({ instruction: serializeInstruction(rows[0]) });
  })
);

router.post(
  '/:id/simulate-inactivity',
  asyncHandler(async (req, res) => {
    const existing = await findOwned(req.userId, req.params.id);
    if (!existing) return res.status(404).json({ error: 'Instruction not found.' });
    const days = Math.max(0, Number(req.body.days) || 0);
    const { rows } = await pool.query(
      `UPDATE instructions SET verification_simulated_days = $1 WHERE id = $2 RETURNING *`,
      [days, req.params.id]
    );
    res.json({ instruction: serializeInstruction(rows[0]) });
  })
);

module.exports = router;
