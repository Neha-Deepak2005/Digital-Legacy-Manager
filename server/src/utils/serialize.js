// Converts snake_case Postgres rows into the camelCase shapes the frontend
// (js/app.js) already expects — this is what keeps the client-side code
// (rendering, readiness score, etc.) unchanged when switching from
// localStorage to a real API.

function serializeBeneficiary(row) {
  return {
    id: row.id,
    name: row.name,
    relationship: row.relationship,
    contact: row.contact,
    trust: row.trust,
    verified: row.verified,
  };
}

function serializeAsset(row) {
  return {
    id: row.id,
    name: row.name,
    category: row.category,
    identifier: row.identifier,
    beneficiaryId: row.beneficiary_id,
    action: row.action,
    status: row.status,
    added: new Date(row.added_at).getTime(),
  };
}

function serializeInstruction(row) {
  return {
    id: row.id,
    title: row.title,
    trigger: row.trigger_condition,
    beneficiaryId: row.beneficiary_id,
    details: row.details,
    status: row.status,
    verification: {
      status: row.verification_status,
      ref: row.verification_ref,
      simulatedDays: row.verification_simulated_days,
    },
  };
}

function serializeMessage(row) {
  return {
    id: row.id,
    subject: row.subject,
    to: row.to_beneficiary_id,
    condition: row.condition,
    body: row.body,
    status: row.status,
    created: new Date(row.created_at).getTime(),
  };
}

function serializeAuditEntry(row) {
  return {
    id: row.id,
    ts: new Date(row.ts).getTime(),
    actor: row.actor,
    action: row.action,
    detail: row.detail,
    status: row.status,
  };
}

function serializeSession(row, currentSessionId) {
  return {
    id: row.id,
    device: row.device,
    location: row.ip || 'Unknown location',
    current: row.id === currentSessionId,
    ts: new Date(row.created_at).getTime(),
  };
}

function serializeSecurity(row) {
  return {
    twoFA: row.two_fa_enabled,
    alerts: row.login_alerts_enabled,
    bio: row.biometric_enabled,
    inactivityDays: row.inactivity_days,
    passwordLastChangedTs: row.password_changed_at ? new Date(row.password_changed_at).getTime() : null,
  };
}

function serializeUser(row) {
  return {
    id: row.id,
    name: row.name,
    email: row.email,
    isDemo: row.is_demo,
  };
}

module.exports = {
  serializeBeneficiary,
  serializeAsset,
  serializeInstruction,
  serializeMessage,
  serializeAuditEntry,
  serializeSession,
  serializeSecurity,
  serializeUser,
};
