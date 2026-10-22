const express = require('express');
const { pool } = require('../db/pool');
const { asyncHandler } = require('../utils/asyncHandler');
const { requireAuth } = require('../middleware/auth');
const { addAudit } = require('../utils/audit');
const { isValidEmail } = require('../utils/validators');
const { serializeBeneficiary, serializeSecurity } = require('../utils/serialize');
const { issueOtp, verifyOtp } = require('../utils/otp');

const router = express.Router();
router.use(requireAuth);

async function getUser(userId) {
  const { rows } = await pool.query('SELECT * FROM users WHERE id = $1', [userId]);
  return rows[0];
}

async function findOwned(userId, id) {
  const { rows } = await pool.query('SELECT * FROM beneficiaries WHERE id = $1 AND user_id = $2', [id, userId]);
  return rows[0] || null;
}

router.get(
  '/',
  asyncHandler(async (req, res) => {
    const { rows } = await pool.query(
      'SELECT * FROM beneficiaries WHERE user_id = $1 ORDER BY created_at ASC',
      [req.userId]
    );
    res.json({ beneficiaries: rows.map(serializeBeneficiary) });
  })
);

router.post(
  '/',
  asyncHandler(async (req, res) => {
    const { name, relationship, trust, contact } = req.body;
    const cleanName = String(name || '').trim();
    const cleanContact = String(contact || '').trim();
    if (!cleanName) return res.status(400).json({ error: 'Give the beneficiary a name first.', field: 'name' });
    if (!isValidEmail(cleanContact)) {
      return res.status(400).json({ error: 'Enter a valid email address.', field: 'contact' });
    }
    const dupe = await pool.query(
      'SELECT name FROM beneficiaries WHERE user_id = $1 AND lower(contact) = lower($2)',
      [req.userId, cleanContact]
    );
    if (dupe.rows[0]) {
      return res
        .status(409)
        .json({ error: `${dupe.rows[0].name} is already using this email address.`, field: 'contact' });
    }

    const user = await getUser(req.userId);
    const { rows } = await pool.query(
      `INSERT INTO beneficiaries (user_id, name, relationship, trust, contact)
       VALUES ($1, $2, $3, $4, $5) RETURNING *`,
      [req.userId, cleanName, String(relationship || '').trim() || 'Not specified', trust === 'Primary' ? 'Primary' : 'Secondary', cleanContact]
    );
    await addAudit(req.userId, user.name, 'Added beneficiary', cleanName, 'success');
    res.status(201).json({ beneficiary: serializeBeneficiary(rows[0]) });
  })
);

router.put(
  '/:id',
  asyncHandler(async (req, res) => {
    const existing = await findOwned(req.userId, req.params.id);
    if (!existing) return res.status(404).json({ error: 'Beneficiary not found.' });

    const { name, relationship, trust, contact } = req.body;
    const cleanName = String(name || '').trim();
    const cleanContact = String(contact || '').trim();
    if (!cleanName) return res.status(400).json({ error: 'Give the beneficiary a name first.', field: 'name' });
    if (!isValidEmail(cleanContact)) {
      return res.status(400).json({ error: 'Enter a valid email address.', field: 'contact' });
    }
    const dupe = await pool.query(
      'SELECT name FROM beneficiaries WHERE user_id = $1 AND lower(contact) = lower($2) AND id <> $3',
      [req.userId, cleanContact, req.params.id]
    );
    if (dupe.rows[0]) {
      return res
        .status(409)
        .json({ error: `${dupe.rows[0].name} is already using this email address.`, field: 'contact' });
    }

    // Changing the email invalidates any prior verification — matches the
    // rule the frontend used to enforce on its own.
    const emailChanged = existing.contact.toLowerCase() !== cleanContact.toLowerCase();
    const nextVerified = emailChanged ? false : existing.verified;

    const { rows } = await pool.query(
      `UPDATE beneficiaries SET name = $1, relationship = $2, trust = $3, contact = $4, verified = $5
       WHERE id = $6 RETURNING *`,
      [
        cleanName,
        String(relationship || '').trim() || 'Not specified',
        trust === 'Primary' ? 'Primary' : 'Secondary',
        cleanContact,
        nextVerified,
        req.params.id,
      ]
    );
    const user = await getUser(req.userId);
    await addAudit(req.userId, user.name, 'Updated beneficiary', cleanName, 'info');
    res.json({ beneficiary: serializeBeneficiary(rows[0]), emailChanged });
  })
);

router.delete(
  '/:id',
  asyncHandler(async (req, res) => {
    const existing = await findOwned(req.userId, req.params.id);
    if (!existing) return res.status(404).json({ error: 'Beneficiary not found.' });
    await pool.query('DELETE FROM beneficiaries WHERE id = $1', [req.params.id]);
    const user = await getUser(req.userId);
    await addAudit(req.userId, user.name, 'Removed beneficiary', existing.name, 'warning');
    res.json({ ok: true });
  })
);

// ---------- email verification (OTP, scoped per-beneficiary) ----------
router.post(
  '/:id/send-verification',
  asyncHandler(async (req, res) => {
    const beneficiary = await findOwned(req.userId, req.params.id);
    if (!beneficiary) return res.status(404).json({ error: 'Beneficiary not found.' });
    const otp = await issueOtp(pool, req.userId, 'beneficiary_verify', beneficiary.id);
    res.json({ devOtp: otp.code });
  })
);

router.post(
  '/:id/verify',
  asyncHandler(async (req, res) => {
    const beneficiary = await findOwned(req.userId, req.params.id);
    if (!beneficiary) return res.status(404).json({ error: 'Beneficiary not found.' });

    const result = await verifyOtp(pool, req.userId, 'beneficiary_verify', req.body.code, beneficiary.id);
    if (!result.ok) {
      const messages = {
        expired: 'That code has expired. Request a new one.',
        too_many_attempts: 'Too many incorrect attempts. Request a new code.',
        not_found: 'No code is pending — request a new one.',
        mismatch: 'That code doesn’t match. Check the demo code and try again.',
      };
      return res.status(400).json({ error: messages[result.reason] || messages.mismatch });
    }

    const { rows } = await pool.query('UPDATE beneficiaries SET verified = true WHERE id = $1 RETURNING *', [
      beneficiary.id,
    ]);
    const user = await getUser(req.userId);
    await addAudit(req.userId, user.name, 'Beneficiary verified', `${beneficiary.name} · ${beneficiary.contact}`, 'success');
    res.json({ beneficiary: serializeBeneficiary(rows[0]) });
  })
);

module.exports = router;
