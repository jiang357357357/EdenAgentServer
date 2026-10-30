import type { AttachmentSnapshot } from '@eden/api'

/** The digest belongs to host integrity checks; blobId is the readable business reference. */
export function modelAttachments(snapshots: readonly AttachmentSnapshot[]) {
  return snapshots.map(({ blobId, mime, filename, byteLength, kind }) => ({ blobId, mime,
    ...(filename === undefined ? {} : { filename }), byteLength, kind }))
}
