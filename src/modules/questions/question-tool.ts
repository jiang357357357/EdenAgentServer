import { z } from 'zod'
import { questionAskSchema, toJson } from '@eden/api'
import type { JsonValue } from '@eden/api'
import type { RuntimeTool } from '@eden/runtime-pi'
import type { QuestionService } from './question-service.ts'
import { toolDescription } from '../../model-prompts/tool-descriptions.ts'

export function questionTool(questions: QuestionService, sessionId: string, turnId: string): RuntimeTool {
  return {
    name: 'request_user_input', revision: 'eden.question.v1', description: toolDescription('request_user_input'),
    parameters: toJson(z.toJSONSchema(questionAskSchema, { io: 'input' })) as Record<string, JsonValue>, executionMode: 'sequential',
    async execute(input, context) { return toJson({ answers: await questions.ask(sessionId, turnId, input, context.signal) }) },
  }
}
