import type { QuestionItem } from '@eden/api'

function validateSupplementaryAnswer(question: QuestionItem, selected: string[], note: string): void {
  if (!selected.length && !note) throw new Error('Answer every question in this request')
  if (!question.multiple && selected.length > 1) throw new Error('This question accepts one answer option')
  if (new Set(selected).size !== selected.length) throw new Error('Duplicate question answer')
  if (selected.some(answer => !question.options.some(option => option.label === answer))) throw new Error('Answer must match a listed option')
  if (note && !question.custom) throw new Error('This question does not accept supplementary answers')
}

function validateCombinedAnswer(question: QuestionItem, selected: string[]): void {
  if (!selected.length) throw new Error('Answer every question in this request')
  const options = selected.filter(answer => question.options.some(option => option.label === answer))
  const notes = selected.filter(answer => !question.options.some(option => option.label === answer))
  if (!question.multiple && options.length > 1) throw new Error('This question accepts one answer option')
  if (notes.length > 1) throw new Error('This question accepts one supplementary answer')
  if (new Set(selected).size !== selected.length) throw new Error('Duplicate question answer')
  if (!question.custom && selected.some(answer => !question.options.some(option => option.label === answer))) throw new Error('Answer must match a listed option')
}

export function validatedQuestionAnswers(questions: QuestionItem[], answers: string[][], supplementary?: string[]): string[][] {
  if (answers.length !== questions.length) throw new Error('Answer every question in this request')
  if (supplementary && supplementary.length !== questions.length) throw new Error('Supplementary answers must match questions')
  for (const [index, question] of questions.entries()) {
    const selected = answers[index]!
    if (supplementary) validateSupplementaryAnswer(question, selected, supplementary[index]!)
    else validateCombinedAnswer(question, selected)
  }
  return supplementary ? answers.map((selected, index) => supplementary[index] ? [...selected, supplementary[index]!] : selected) : answers
}
