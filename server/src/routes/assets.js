const express = require('express');
const { pool } = require('../db/pool');
const { asyncHandler } = require('../utils/asyncHandler');
const { requireAuth } = require('../middleware/auth');
const { addAudit } = require('../utils/audit');
const { isValidEmail } = require('../utils/validators');
const { serializeAsset } = require('../utils/serialize');

const router = express.Router();
router.use(requireAuth);

async function getUser(userId) {
  const { rows } = await pool.query('SELECT * FROM users WHERE id = $1', [userId]);
  return rows[0];
}

async function findOwned(userId, id) {
  const { rows } = await pool.query('SELECT * FROM assets WHERE id = $1 AND user_id = $2', [id, userId]);
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

function validateAssetInput(body) {
  const name = String(body.name || '').trim();
  const category = String(body.category || '').trim();
  const identifier = String(body.identifier || '').trim();
  if (!name) return { error: 'Give the asset a name first.', field: 'name' };
  if (!identifier) {
    return {
      error: category === 'email' ? 'Enter an email address.' : 'Enter an account reference or identifier.',
      field: 'identifier',
    };
  }
  if (category === 'email' && !isValidEmail(identifier)) {
    return { error: 'Enter a valid email address.', field: 'identifier' };
  }
  return { name, category, identifier };
}

router.get(
  '/',
  asyncHandler(async (req, res) => {
    const { rows } = await pool.query('SELECT * FROM assets WHERE user_id = $1 ORDER BY added_at ASC', [
      req.userId,
    ]);
    res.json({ assets: rows.map(serializeAsset) });
  })
);

router.post(
  '/',
  asyncHandler(async (req, res) => {
    const parsed = validateAssetInput(req.body);
    if (parsed.error) return res.status(400).json(parsed);

    const beneficiaryId = await validateBeneficiaryId(req.userId, req.body.beneficiaryId);
    const status = req.body.status === 'Pending Review' ? 'Pending Review' : 'Active';
    const action = String(req.body.action || 'Transfer to beneficiary');

    const { rows } = await pool.query(
      `INSERT INTO assets (user_id, name, category, identifier, beneficiary_id, action, status)
       VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING *`,
      [req.userId, parsed.name, parsed.category, parsed.identifier, beneficiaryId, action, status]
    );
    const user = await getUser(req.userId);
    await addAudit(req.userId, user.name, 'Added asset', parsed.name, 'info');
    res.status(201).json({ asset: serializeAsset(rows[0]) });
  })
);

router.put(
  '/:id',
  asyncHandler(async (req, res) => {
    const existing = await findOwned(req.userId, req.params.id);
    if (!existing) return res.status(404).json({ error: 'Asset not found.' });

    const parsed = validateAssetInput(req.body);
    if (parsed.error) return res.status(400).json(parsed);

    const beneficiaryId = await validateBeneficiaryId(req.userId, req.body.beneficiaryId);
    const status = req.body.status === 'Pending Review' ? 'Pending Review' : 'Active';
    const action = String(req.body.action || existing.action);

    const { rows } = await pool.query(
      `UPDATE assets SET name = $1, category = $2, identifier = $3, beneficiary_id = $4, action = $5, status = $6
       WHERE id = $7 RETURNING *`,
      [parsed.name, parsed.category, parsed.identifier, beneficiaryId, action, status, req.params.id]
    );
    const user = await getUser(req.userId);
    await addAudit(req.userId, user.name, 'Updated asset', parsed.name, 'info');
    res.json({ asset: serializeAsset(rows[0]) });
  })
);

router.delete(
  '/:id',
  asyncHandler(async (req, res) => {
    const existing = await findOwned(req.userId, req.params.id);
    if (!existing) return res.status(404).json({ error: 'Asset not found.' });
    await pool.query('DELETE FROM assets WHERE id = $1', [req.params.id]);
    const user = await getUser(req.userId);
    await addAudit(req.userId, user.name, 'Removed asset', existing.name, 'warning');
    res.json({ ok: true });
  })
);

module.exports = router;
