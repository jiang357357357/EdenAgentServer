import { credentialValues } from '@eden/api'

export function memoryContent(raw: string, known: readonly string[] = []): string {
  const content = raw.replace(/\s+/g, ' ').trim()
  if (!content || content.length > 16000) throw new Error('Memory content must contain 1 to 16000 characters')
  if (credentialValues(content).length || known.some(value => value.length >= 3 && content.includes(value))) {
    throw new Error('Credentials cannot be stored in long-term memory')
  }
  return content
}
