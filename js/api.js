/* =========================================================================
   DIGITAL LEGACY MANAGER — API client
   Thin fetch wrapper around the Express + PostgreSQL backend in /server.
   Every call here hits a real HTTP endpoint — nothing in this file touches
   localStorage for app data (only the JWT itself is kept there, which is
   the normal place a browser app keeps its login token).
   ========================================================================= */
const API_BASE = 'https://digital-legacy-manager.onrender.com/api';
const TOKEN_KEY = 'dlm_token_v1';

function getToken(){ try{ return localStorage.getItem(TOKEN_KEY); }catch(e){ return null; } }
function setToken(token){
  try{
    if(token) localStorage.setItem(TOKEN_KEY, token);
    else localStorage.removeItem(TOKEN_KEY);
  }catch(e){}
}

class ApiError extends Error{
  constructor(message, status, field){
    super(message);
    this.status = status;
    this.field = field;
  }
}

async function apiRequest(method, path, body){
  const headers = { 'Content-Type': 'application/json' };
  const token = getToken();
  if(token) headers.Authorization = 'Bearer ' + token;

  let res;
  try{
    res = await fetch(API_BASE + path, {
      method,
      headers,
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
  }catch(networkErr){
    throw new ApiError('Can’t reach the server. Make sure the backend (npm run dev in /server) is running.', 0);
  }

  let data = null;
  try{ data = await res.json(); }catch(e){ /* empty body is fine */ }

  if(!res.ok){
    throw new ApiError((data && data.error) || 'Something went wrong.', res.status, data && data.field);
  }
  return data || {};
}

const api = {
  // ---- auth ----
  signup: (name, email, password) => apiRequest('POST', '/auth/signup', { name, email, password }),
  login: (email, password) => apiRequest('POST', '/auth/login', { email, password }),
  verifySignup: (userId, code) => apiRequest('POST', '/auth/verify-signup', { userId, code }),
  verifyLogin: (userId, code) => apiRequest('POST', '/auth/verify-login', { userId, code }),
  resendOtp: (userId, scope) => apiRequest('POST', '/auth/resend-otp', { userId, scope }),
  forgotPassword: (email) => apiRequest('POST', '/auth/forgot-password', { email }),
  verifyReset: (userId, code) => apiRequest('POST', '/auth/verify-reset', { userId, code }),
  resetPassword: (resetToken, newPassword) => apiRequest('POST', '/auth/reset-password', { resetToken, newPassword }),
  me: () => apiRequest('GET', '/auth/me'),
  logout: () => apiRequest('POST', '/auth/logout'),
  changePassword: (currentPassword, newPassword) =>
    apiRequest('POST', '/auth/change-password', { currentPassword, newPassword }),
  setup2fa: () => apiRequest('POST', '/auth/2fa/setup'),
  confirm2fa: (code) => apiRequest('POST', '/auth/2fa/confirm', { code }),
  disable2fa: () => apiRequest('POST', '/auth/2fa/disable'),

  // ---- assets ----
  getAssets: () => apiRequest('GET', '/assets'),
  createAsset: (data) => apiRequest('POST', '/assets', data),
  updateAsset: (id, data) => apiRequest('PUT', '/assets/' + id, data),
  deleteAsset: (id) => apiRequest('DELETE', '/assets/' + id),

  // ---- beneficiaries ----
  getBeneficiaries: () => apiRequest('GET', '/beneficiaries'),
  createBeneficiary: (data) => apiRequest('POST', '/beneficiaries', data),
  updateBeneficiary: (id, data) => apiRequest('PUT', '/beneficiaries/' + id, data),
  deleteBeneficiary: (id) => apiRequest('DELETE', '/beneficiaries/' + id),
  sendBeneficiaryVerification: (id) => apiRequest('POST', `/beneficiaries/${id}/send-verification`),
  verifyBeneficiary: (id, code) => apiRequest('POST', `/beneficiaries/${id}/verify`, { code }),

  // ---- instructions ----
  getInstructions: () => apiRequest('GET', '/instructions'),
  createInstruction: (data) => apiRequest('POST', '/instructions', data),
  updateInstruction: (id, data) => apiRequest('PUT', '/instructions/' + id, data),
  deleteInstruction: (id) => apiRequest('DELETE', '/instructions/' + id),
  requestInstructionVerification: (id) => apiRequest('POST', `/instructions/${id}/request-verification`),
  resolveInstructionVerification: (id, approved) => apiRequest('POST', `/instructions/${id}/resolve`, { approved }),
  simulateInactivity: (id, days) => apiRequest('POST', `/instructions/${id}/simulate-inactivity`, { days }),

  // ---- messages ----
  getMessages: () => apiRequest('GET', '/messages'),
  createMessage: (data) => apiRequest('POST', '/messages', data),
  updateMessage: (id, data) => apiRequest('PUT', '/messages/' + id, data),
  deleteMessage: (id) => apiRequest('DELETE', '/messages/' + id),

  // ---- audit ----
  getAudit: () => apiRequest('GET', '/audit'),

  // ---- security ----
  toggleSecurity: (key) => apiRequest('POST', '/security/toggle', { key }),
  setInactivityDays: (days) => apiRequest('PUT', '/security/inactivity-days', { days }),
  getSessions: () => apiRequest('GET', '/security/sessions'),
  revokeSession: (id) => apiRequest('DELETE', '/security/sessions/' + id),
};
