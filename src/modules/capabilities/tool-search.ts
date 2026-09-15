import type { RuntimeTool } from '@eden/runtime-pi'

const normalize = (text: string) => text.toLowerCase().replace(/[\s_:-]+/g, ' ').trim()

export function searchTools(tools: RuntimeTool[], query: string): RuntimeTool[] {
  const phrase = normalize(query), words = phrase.split(' ').filter(Boolean)
  if (!words.length) return tools
  return tools.map(tool => {
    const name = normalize(tool.name), identity = normalize(tool.identity ?? tool.name)
    const text = `${identity} ${name} ${normalize(tool.description)}`
    const matches = words.every(word => text.includes(word))
    const score = name === phrase || identity === phrase ? 3 : words.every(word => name.includes(word)) ? 2 : 1
    return { tool, score: matches ? score : 0 }
  }).filter(item => item.score > 0).sort((a, b) => b.score - a.score).map(item => item.tool)
}
