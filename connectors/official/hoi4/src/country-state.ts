import type { JsonValue } from '@eden/api/connector'

export function countryState(fields: Record<string, string>): Record<string, JsonValue> {
  return {
    date: textField(fields['date']),
    countryTag: textField(fields['country_tag']),
    countryName: textField(fields['country_name']),
    politicalPower: numberField(fields['political_power']),
    stability: ratioField(fields['stability']),
    warSupport: ratioField(fields['war_support']),
    manpowerThousands: numberField(fields['manpower_k']),
    maxManpowerThousands: numberField(fields['max_manpower_k']),
    fuelThousands: numberField(fields['fuel_k']),
    maxFuelThousands: numberField(fields['max_fuel_k']),
    civilianFactories: numberField(fields['civilian_factories']),
    militaryFactories: numberField(fields['military_factories']),
    navalFactories: numberField(fields['naval_factories']),
    armyExperience: numberField(fields['army_experience']),
    navyExperience: numberField(fields['navy_experience']),
    airExperience: numberField(fields['air_experience']),
    atWar: boolField(fields['at_war']),
    inFaction: boolField(fields['in_faction']),
  }
}
function textField(value: string | undefined) { return value?.trim() || null }
function numberField(value: string | undefined) {
  const raw = value?.trim().replace(/%$/, '').replace(/[, ]/g, '').replace(/−/g, '-')
  if (!raw) return null
  const number = Number(raw)
  return Number.isFinite(number) ? number : null
}
function ratioField(value: string | undefined) {
  const number = numberField(value)
  return number === null ? null : value?.trim().endsWith('%') ? number / 100 : number
}
function boolField(value: string | undefined) {
  const raw = value?.trim().toLowerCase() ?? ''
  if (['1', 'yes', 'true'].includes(raw)) return true
  return ['0', 'no', 'false'].includes(raw) ? false : null
}
