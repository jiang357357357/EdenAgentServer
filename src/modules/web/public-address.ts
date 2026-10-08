import { isIP } from 'node:net'

// Preserve the request boundary's reserved IPv4 ranges, including all of 192.0/16.
const reservedIpv4Ranges = [
  '0.0.0.0/8', '10.0.0.0/8', '127.0.0.0/8', '100.64.0.0/10',
  '169.254.0.0/16', '172.16.0.0/12', '192.0.0.0/16', '192.168.0.0/16',
  '198.18.0.0/15', '198.51.100.0/24', '203.0.113.0/24', '224.0.0.0/3',
].map(cidr => {
  const [network, prefix] = cidr.split('/')
  const start = ipv4Number(network!)
  return { start, end: start + 2 ** (32 - Number(prefix)) }
})

function ipv4Number(address: string): number {
  return address.split('.').reduce((value, octet) => value * 256 + Number(octet), 0)
}

export function isPublicAddress(address: string): boolean {
  const family = isIP(address)
  if (family === 4) {
    const value = ipv4Number(address)
    return !reservedIpv4Ranges.some(range => value >= range.start && value < range.end)
  }
  if (family !== 6) return false
  const value = address.toLowerCase()
  // IPv4-mapped IPv6 may encode private IPv4 addresses in hexadecimal form.
  if (value.includes(':ffff:')) return false
  return !(value === '::' || value === '::1' || value.startsWith('fc') || value.startsWith('fd')
    || /^fe[89ab]/.test(value) || value.startsWith('ff') || value.startsWith('2001:db8:')
    || value.startsWith('2001:0:') || value.startsWith('2001:2:') || value.startsWith('2002:'))
}
