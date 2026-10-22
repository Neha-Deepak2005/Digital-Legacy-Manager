const { pool } = require('../db/pool');
const { verifyToken } = require('../utils/jwt');

/**
 * Requires a valid, non-expired JWT whose session (jti) still exists in the
 * sessions table. Deleting that row — which "Sign out" does — revokes the
 * token immediately, even though the JWT itself would otherwise still be
 * valid until it expires.
 */
async function requireAuth(req, res, next) {
  const header = req.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : null;
  if (!token) return res.status(401).json({ error: 'Missing bearer token.' });

  let payload;
  try {
    payload = verifyToken(token);
  } catch (err) {
    return res.status(401).json({ error: 'Invalid or expired session. Please log in again.' });
  }

  const sessionId = payload.jti;
  const userId = payload.sub;
  try {
    const { rows } = await pool.query('SELECT id FROM sessions WHERE id = $1 AND user_id = $2', [
      sessionId,
      userId,
    ]);
    if (!rows[0]) {
      return res.status(401).json({ error: 'Session has been signed out. Please log in again.' });
    }
    pool.query('UPDATE sessions SET last_seen_at = now() WHERE id = $1', [sessionId]).catch(() => {});
    req.userId = userId;
    req.sessionId = sessionId;
    next();
  } catch (err) {
    next(err);
  }
}

module.exports = { requireAuth };
