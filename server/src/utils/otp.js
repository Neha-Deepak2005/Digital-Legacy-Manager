const crypto = require('crypto');

const OTP_TTL_MINUTES = 10;
const MAX_ATTEMPTS = 5;

function generateOtp() {
  // 6-digit numeric code, zero-padded.
  return String(crypto.randomInt(0, 1000000)).padStart(6, '0');
}

function hashOtp(code) {
  return crypto.createHash('sha256').update(String(code)).digest('hex');
}

/**
 * Issues a fresh OTP for (userId, scope, targetId). `targetId` disambiguates
 * multiple concurrent codes of the same scope for the same user — e.g.
 * verifying two different beneficiaries' emails at once — and should be
 * omitted (null) for scopes that only ever have one code in flight.
 */
async function issueOtp(client, userId, scope, targetId = null) {
  const code = generateOtp();
  const codeHash = hashOtp(code);
  const expiresAt = new Date(Date.now() + OTP_TTL_MINUTES * 60 * 1000);
  // Invalidate any earlier unconsumed codes for this user+scope+target so
  // only the latest one can ever be used.
  await client.query(
    `UPDATE otp_codes SET consumed_at = now()
     WHERE user_id = $1 AND scope = $2 AND target_id IS NOT DISTINCT FROM $3 AND consumed_at IS NULL`,
    [userId, scope, targetId]
  );
  const { rows } = await client.query(
    `INSERT INTO otp_codes (user_id, scope, target_id, code_hash, expires_at)
     VALUES ($1, $2, $3, $4, $5) RETURNING id`,
    [userId, scope, targetId, codeHash, expiresAt]
  );
  return { id: rows[0].id, code, expiresAt };
}

/**
 * Verifies a submitted code against the most recent unconsumed OTP for this
 * user+scope+target. Returns { ok: true } on success (and marks it
 * consumed), or { ok: false, reason } on failure — 'not_found', 'expired',
 * 'too_many_attempts', or 'mismatch'.
 */
async function verifyOtp(client, userId, scope, submitted, targetId = null) {
  const { rows } = await client.query(
    `SELECT * FROM otp_codes
     WHERE user_id = $1 AND scope = $2 AND target_id IS NOT DISTINCT FROM $3 AND consumed_at IS NULL
     ORDER BY created_at DESC LIMIT 1`,
    [userId, scope, targetId]
  );
  const row = rows[0];
  if (!row) return { ok: false, reason: 'not_found' };
  if (new Date(row.expires_at).getTime() < Date.now()) {
    return { ok: false, reason: 'expired' };
  }
  if (row.attempts >= MAX_ATTEMPTS) {
    return { ok: false, reason: 'too_many_attempts' };
  }
  if (hashOtp(submitted) !== row.code_hash) {
    await client.query(`UPDATE otp_codes SET attempts = attempts + 1 WHERE id = $1`, [row.id]);
    return { ok: false, reason: 'mismatch' };
  }
  await client.query(`UPDATE otp_codes SET consumed_at = now() WHERE id = $1`, [row.id]);
  return { ok: true };
}

module.exports = { generateOtp, hashOtp, issueOtp, verifyOtp, OTP_TTL_MINUTES };
