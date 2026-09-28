/** Generated with pyfiglet 1.0.4: `pyfiglet -f ansi_shadow EDEN`. */
const art = [
  '███████╗██████╗ ███████╗███╗   ██╗',
  '██╔════╝██╔══██╗██╔════╝████╗  ██║',
  '█████╗  ██║  ██║█████╗  ██╔██╗ ██║',
  '██╔══╝  ██║  ██║██╔══╝  ██║╚██╗██║',
  '███████╗██████╔╝███████╗██║ ╚████║',
  '╚══════╝╚═════╝ ╚══════╝╚═╝  ╚═══╝',
] as const

/** Eden's purple accent fades into the pale interface highlight from top to bottom. */
const gradient = [
  '169;155;239', '182;170;241', '196;186;243',
  '211;202;245', '225;219;246', '238;235;246',
] as const

export const edenWordmarkHeight = art.length
export const edenWordmarkWidth = art[0].length

export function edenWordmarkRow(row: number, color: boolean): string {
  const line = art[row] ?? ''
  return color ? `\x1b[38;2;${gradient[row] ?? gradient[0]}m${line}\x1b[0m` : line
}
