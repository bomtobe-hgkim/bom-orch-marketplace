import { REASON } from './reason-codes.mjs';
import { renderNotice } from './reason-text.mjs';

/**
 * Shared-state readers use one shape for upper-version retreat.  Converting it
 * here keeps every user-facing producer on the same registered reason/notice.
 */
function paramsOf(stateSchema) {
  if (stateSchema === null || typeof stateSchema !== 'object' || Array.isArray(stateSchema) ||
      stateSchema.status !== 'newer' || typeof stateSchema.file !== 'string' || stateSchema.file === '' ||
      !Number.isInteger(stateSchema.found) || !Number.isInteger(stateSchema.supported) ||
      stateSchema.supported < 0 || stateSchema.found <= stateSchema.supported) return null;
  return {
    file: stateSchema.file,
    version: stateSchema.found,
    supported: stateSchema.supported,
  };
}

/** Envelope failure input for an explicit write against an opaque future file. */
export function stateSchemaReason(stateSchema) {
  const params = paramsOf(stateSchema);
  return params === null ? null : { reasonCode: REASON.state_schema_newer, params };
}

/** Advisory text for a read that safely fell back to defaults. */
export function stateSchemaNotice(stateSchema) {
  const params = paramsOf(stateSchema);
  return params === null ? null : renderNotice('state_schema_newer', params);
}
