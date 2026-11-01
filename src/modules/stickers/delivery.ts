import { toJson } from '@eden/api'
import type { CharacterSticker } from '@eden/api'
import type { RuntimeTool } from '@eden/runtime-pi'
import type { MonBindingService, NapcatClient } from '../mon/index.ts'
import type { SessionRepository } from '../sessions/index.ts'
import type { PermissionService } from '../permissions/index.ts'
import { assertImageSignature } from '../attachments/index.ts'
import { downloadStickerImage } from './image-source.ts'

type ToolContext = Parameters<RuntimeTool['execute']>[1]

export class StickerDelivery {
  constructor(private readonly repository: SessionRepository, private readonly permissions: PermissionService,
    private readonly napcat: NapcatClient, private readonly sessionId: string, private readonly turnId: string,
    private readonly actorId?: string | number) {}

  private publish(sticker: CharacterSticker) {
    this.repository.events.append(this.sessionId, this.turnId, 'character.sticker.sent', {
      presentation: 'standalone.v1',
      part: { type: 'sticker', stickerId: sticker.id, characterId: sticker.character_id,
        name: sticker.name, url: sticker.image_url, alt: sticker.description },
      ...(this.actorId === undefined ? {} : { actor: { assistantID: this.actorId } }),
    })
  }

  async send(sticker: CharacterSticker, character: ReturnType<MonBindingService['characterContext']>,
    context: ToolContext, assertCurrent: () => void) {
    assertCurrent()
    if (this.repository.read(this.sessionId).sourceChannel !== 'qq') {
      this.publish(sticker)
      return toJson({ sticker, channel: 'app', status: 'success' })
    }
    const target = this.napcat.target(this.sessionId)
    if (!target.qqContext) throw new Error('Sticker sending requires a bound QQ conversation')
    const group = target.qqContext.group_qq
    const action = group ? 'send_group_sticker' : 'send_private_sticker'
    await this.permissions.request({ ...context, sessionId: this.sessionId, turnId: this.turnId, assertCurrent },
      'qq.napcat.write', `${target.resource}:${action}`,
      toJson({ channel: 'qq_action', action, bot: target.qqContext.bot_qq,
        params: { ...(group ? { group_id: group } : { user_id: target.qqContext.contact_qq }), sticker: sticker.name } }))
    context.signal.throwIfAborted(); assertCurrent(); this.napcat.assertCurrent(target)
    const image = await downloadStickerImage(sticker.image_url, context.signal)
    assertImageSignature(image.bytes, image.mime)
    assertCurrent(); character.assertCurrent()
    const receipt = await this.napcat.execute(target, action, {
      ...(group ? { group_id: group } : { user_id: target.qqContext.contact_qq }), image_base64: image.bytes.toString('base64'),
    }, 'write', `${this.turnId}:${context.callId}`, context.signal, assertCurrent)
    if (receipt.status === 'success') this.publish(sticker)
    return toJson({ sticker, channel: 'qq', status: receipt.status, receipt })
  }
}
