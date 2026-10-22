const express = require('express');
const { pool } = require('../db/pool');
const { asyncHandler } = require('../utils/asyncHandler');
const { requireAuth } = require('../middleware/auth');
const { serializeAuditEntry } = require('../utils/serialize');

const router = express.Router();
router.use(requireAuth);

router.get(
  '/',
  asyncHandler(async (req, res) => {
    // Most recent 60 entries, matching the cap the prototype used to keep
    // in localStorage.
    const { rows } = await pool.query(
      'SELECT * FROM audit_log WHERE user_id = $1 ORDER BY ts DESC LIMIT 60',
      [req.userId]
    );
    res.json({ auditLog: rows.map(serializeAuditEntry) });
  })
);

module.exports = router;
