import assert from 'node:assert/strict'
import test from 'node:test'
import { napcatPermissionPreview } from '../../../src/modules/qq-channel/napcat-preview.ts'

test('card approval keeps source and all destination identifiers ahead of truncated content', () => {
  const preview = napcatPermissionPreview({ channel: 'qq_action', bot: '123456', action: 'send_miniapp_card',
    params: { title: '长正文'.repeat(500), source_message_id: '1000000000001', target_user_id: '2000000000002',
      target_group_id: '3000000000003', contact_user_id: '4000000000004', contact_group_id: '5000000000005' } })!
  for (const target of ['source_message_id=1000000000001', 'target_user_id=2000000000002',
    'target_group_id=3000000000003', 'contact_user_id=4000000000004', 'contact_group_id=5000000000005']) {
    assert.ok(preview.includes(target))
    assert.ok(preview.indexOf(target) < preview.indexOf('参数:'))
  }
})

test('inline images show byte estimates without leaking base64 into approval previews', () => {
  const image = Buffer.from('test-image-bytes').toString('base64')
  const preview = napcatPermissionPreview({ channel: 'qq_action', bot: '123456', action: 'set_qq_avatar',
    params: { image_base64: image, nested: { file: `data:image/png;base64,${image}` } } })!
  assert.match(preview, /图片数据，约 16 字节/)
  assert.equal(preview.includes(image), false)
})
