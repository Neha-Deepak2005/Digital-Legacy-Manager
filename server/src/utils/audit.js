const { pool } = require('../db/pool');

async function addAudit(userId, actor, action, detail, status = 'info') {
  await pool.query(
    `INSERT INTO audit_log (user_id, actor, action, detail, status) VALUES ($1, $2, $3, $4, $5)`,
    [userId, actor, action, detail || null, status]
  );
}

module.exports = { addAudit };
