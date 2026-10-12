/** Callers use the fixed candidate alias; raw events remain available for auditing. */
export const messageNotDeletedSql = `NOT EXISTS (SELECT 1 FROM events removed
  WHERE removed.session_id=candidate.session_id AND removed.kind='message.deleted'
  AND json_extract(removed.payload_json,'$.messageId')=
  COALESCE(json_extract(candidate.payload_json,'$.messageId'),json_extract(candidate.payload_json,'$.messageID'),candidate.id))`
