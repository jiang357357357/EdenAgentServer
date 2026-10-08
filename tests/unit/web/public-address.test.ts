import assert from 'node:assert/strict'
import test from 'node:test'
import { isPublicAddress } from '../../../src/modules/web/index.ts'

test('public address filtering retains IPv4 range boundaries', () => {
  const reserved = [
    '0.0.0.0', '0.255.255.255', '10.0.0.0', '10.255.255.255',
    '127.0.0.0', '127.255.255.255', '100.64.0.0', '100.127.255.255',
    '169.254.0.0', '169.254.255.255', '172.16.0.0', '172.31.255.255',
    '192.0.0.0', '192.0.255.255', '192.168.0.0', '192.168.255.255',
    '198.18.0.0', '198.19.255.255', '198.51.100.0', '198.51.100.255',
    '203.0.113.0', '203.0.113.255', '224.0.0.0', '255.255.255.255',
  ]
  const publicNeighbors = [
    '1.0.0.0', '9.255.255.255', '11.0.0.0', '126.255.255.255', '128.0.0.0',
    '100.63.255.255', '100.128.0.0', '169.253.255.255', '169.255.0.0',
    '172.15.255.255', '172.32.0.0', '191.255.255.255', '192.1.0.0',
    '192.167.255.255', '192.169.0.0', '198.17.255.255', '198.20.0.0',
    '198.51.99.255', '198.51.101.0', '203.0.112.255', '203.0.114.0', '223.255.255.255',
  ]
  for (const address of reserved) assert.equal(isPublicAddress(address), false, address)
  for (const address of publicNeighbors) assert.equal(isPublicAddress(address), true, address)
})

test('public address filtering preserves IPv6 and invalid input rejection', () => {
  for (const address of ['::', '::1', '::ffff:127.0.0.1', '::FFFF:7f00:1', 'fc00::1', 'fd00::1',
    'fe80::1', 'febf::1', 'ff00::1', '2001:db8::1', '2001:0::1', '2001:2::1', '2002::1', '', 'localhost', '256.1.1.1']) {
    assert.equal(isPublicAddress(address), false, address)
  }
  assert.equal(isPublicAddress('2606:4700:4700::1111'), true)
})
