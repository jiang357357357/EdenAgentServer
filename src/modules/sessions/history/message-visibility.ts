/** Callers use the fixed candidate alias; raw events remain available for auditing. */
export const messageNotDeletedSql = `NOT EXISTS (SELECT 1 FROM events removed
  WHERE removed.session_id=candidate.session_id AND removed.kind='message.deleted'
  AND json_extract(removed.payload_json,'$.messageId')=
  COALESCE(json_extract(candidate.payload_json,'$.messageId'),json_extract(candidate.payload_json,'$.messageID'),candidate.id))`

/** Old group deletions predate standalone sticker IDs. Do not resurrect their legacy side events. */
export const chatMessageNotDeletedSql = `${messageNotDeletedSql} AND (
  candidate.kind != 'character.sticker.sent' OR json_extract(candidate.payload_json,'$.presentation')='standalone.v1'
  OR NOT EXISTS (SELECT 1 FROM events removed WHERE removed.session_id=candidate.session_id AND removed.kind='message.deleted'
    AND json_type(removed.payload_json,'$.replyGroupId')='text'
    AND json_extract(removed.payload_json,'$.messageId')=(SELECT
      COALESCE(json_extract(owner.payload_json,'$.messageId'),json_extract(owner.payload_json,'$.messageID'),owner.id)
      FROM events owner WHERE owner.session_id=candidate.session_id AND owner.turn_id IS candidate.turn_id
      AND owner.kind='agent.message_end' AND owner.seq<candidate.seq AND json_extract(owner.payload_json,'$.message.role')='assistant'
      AND CAST(json_extract(owner.payload_json,'$.actor.assistantID') AS TEXT) IS CAST(json_extract(candidate.payload_json,'$.actor.assistantID') AS TEXT)
      ORDER BY owner.seq DESC LIMIT 1)))`
