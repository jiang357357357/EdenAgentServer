import { modelEnvironment } from '@eden/api'

/** Location metadata describes a saved report, not a fresh sensor observation. */
export function modelEnvironmentContext(value: unknown) {
  const environment = modelEnvironment(value)
  const location = environment?.location
  if (!environment || !location || ![location.country, location.region, location.city, location.district, location.source, location.updated_at].some(Boolean)) return environment
  return { ...environment, locationInterpretation: '位置为保存的资料快照；source 是记录来源，updated_at 是资料更新时间，accuracy 单位为米。是否仍在该位置尚未核实；时区标识不代表所在地。' }
}
