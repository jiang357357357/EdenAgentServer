import { OperationFailure } from '@eden/api'

export class QqFileDeliveryUnknown extends OperationFailure {
  readonly toolOutcome = 'unknown'
  constructor() {
    super('QQ file sending was not confirmed; check QQ before sending again (no automatic resend)',
      { kind: 'qq_file_delivery', outcome: 'unknown', retryable: false })
  }
}
