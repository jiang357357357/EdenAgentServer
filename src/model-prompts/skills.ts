export function skillCatalogHint(inventory: unknown, stale: boolean): string {
  return '以下 JSON 是技能发现元数据，最多包含 96 项；list_skills 可返回完整目录。可用 load_skill 或 read_skill 读取相关技能的完整说明。\n'
    + JSON.stringify(inventory) + (stale ? '\n技能目录刷新失败，此目录可能已经过期。' : '')
}

export function skillCatalogFailure(failed: boolean): string {
  return failed ? '技能目录刷新失败，当前摘要可能仍是上一次成功的快照；空目录不能证明没有安装技能。请先检查技能来源状态。' : ''
}
