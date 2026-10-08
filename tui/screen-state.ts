import type { StyledSpan } from './styled-text.ts'

export interface ScreenEntry { key?: string; label: string; text: string; complete?: boolean; time?: number }
export interface ScreenSession { id: string; title: string; busy: boolean }
export interface ScreenMenuItem { label: string; command: string; detail?: string }
export interface ScreenPanel { title: string; lines: string[]; items?: ScreenMenuItem[]; selected: number;
  searchable?: boolean; query?: string }
export interface ScreenSuggestions { items: ScreenMenuItem[]; selected: number }
export interface ScreenState {
  width: number; height: number; origin: string; connected: boolean; busy: boolean
  title: string; sessionId?: string; sessions: ScreenSession[]; entries: ScreenEntry[]
  scroll: number; older: boolean; permissions: number; questions: number
  input: string; inputCursor: number; inputLabel: string; panel?: ScreenPanel
  slashSuggestions?: ScreenSuggestions
  sidebarVisible: boolean; contextTokens?: number | null; modelLabel?: string; modelAvailable?: boolean
  agentLabel?: string; location?: string
  authStage?: 'username' | 'password' | 'connecting' | 'authenticated' | 'server_error' | 'local'
  accountLabel?: string; authMessage?: string
}
export interface Frame { lines: string[]; cursorRow: number; cursorColumn: number; transcriptHeight: number }
export type ColoredLine = { text: string; kind: 'normal' | 'muted' | 'accent' | 'user' | 'userBody' | 'tool' | 'error' | 'warning' | 'code' | 'heading' | 'quote'; spans?: StyledSpan[] }
