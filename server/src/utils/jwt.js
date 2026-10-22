const jwt = require('jsonwebtoken');

const SECRET = process.env.JWT_SECRET || 'dev-only-change-me-please';
const EXPIRES_IN = process.env.JWT_EXPIRES_IN || '7d';

function signToken({ userId, sessionId }) {
  // `sessionId` becomes the JWT's jti — it's what lets us revoke a single
  // logged-in session server-side (see sessions table) instead of just
  // trusting whatever token the client happens to hold.
  return jwt.sign({ sub: userId }, SECRET, { expiresIn: EXPIRES_IN, jwtid: sessionId });
}

function verifyToken(token) {
  return jwt.verify(token, SECRET); // throws if invalid/expired
}

module.exports = { signToken, verifyToken };
