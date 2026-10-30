import { createHash } from 'node:crypto'
import { createReadStream, existsSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { Tokenizer } from '@huggingface/tokenizers'
import { z } from 'zod'
import { bertGraph } from './bert-graph.ts'
import type { BertConfig } from './bert-graph.ts'

const files = ['config.json', '1_Pooling/config.json', 'tokenizer.json', 'model.safetensors']
const modelConfig = z.object({ model_type: z.literal('bert'), hidden_act: z.literal('gelu'), hidden_size: z.number().int().positive(),
  num_hidden_layers: z.number().int().positive().max(48), num_attention_heads: z.number().int().positive(),
  intermediate_size: z.number().int().positive(), layer_norm_eps: z.number().positive(), max_position_embeddings: z.number().int().positive(),
  pad_token_id: z.number().int().nonnegative(), position_embedding_type: z.literal('absolute').optional() })

export class LocalEmbedding {
  private loading: Promise<void> | undefined
  private session: import('onnxruntime-node').InferenceSession | undefined
  private tokenizer: Tokenizer | undefined
  private config: BertConfig | undefined
  fingerprint = ''
  dimension = 0
  constructor(readonly modelPath: string) {}
  health(): boolean { return files.every(name => existsSync(path.join(this.modelPath, name))) }
  async load(): Promise<void> {
    this.loading ??= this.initialize().catch(error => { this.loading = undefined; throw error })
    return this.loading
  }
  private async initialize(): Promise<void> {
    if (!this.health()) throw new Error(`本地 BGE 模型文件不完整：${this.modelPath}`)
    const config = modelConfig.parse(JSON.parse(readFileSync(path.join(this.modelPath, 'config.json'), 'utf8')))
    if (config.hidden_size % config.num_attention_heads) throw new Error('BGE 注意力维度无效')
    const pooling = JSON.parse(readFileSync(path.join(this.modelPath, '1_Pooling/config.json'), 'utf8')) as Record<string, unknown>
    if (pooling.pooling_mode_cls_token !== true || Object.entries(pooling).some(([key, value]) => key.startsWith('pooling_mode_') && key !== 'pooling_mode_cls_token' && value === true))
      throw new Error('当前本地模型要求 CLS pooling')
    const hash = createHash('sha256')
    for (const name of files) {
      hash.update(name)
      for await (const chunk of createReadStream(path.join(this.modelPath, name))) hash.update(chunk)
    }
    const runtime = await import('onnxruntime-node')
    this.session = await runtime.InferenceSession.create(bertGraph(readFileSync(path.join(this.modelPath, 'model.safetensors')), config),
      { executionProviders: ['cpu'], intraOpNumThreads: 2, interOpNumThreads: 1, graphOptimizationLevel: 'all' })
    this.tokenizer = new Tokenizer(JSON.parse(readFileSync(path.join(this.modelPath, 'tokenizer.json'), 'utf8')), {})
    this.config = config; this.dimension = config.hidden_size; this.fingerprint = `sha256:${hash.digest('hex')}`
  }
  async embed(text: string): Promise<number[]> {
    await this.load()
    const runtime = await import('onnxruntime-node')
    const encoded = this.tokenizer!.encode(text, { add_special_tokens: true })
    const ids: number[] = encoded.ids.slice(0, this.config!.max_position_embeddings)
    if (!ids.length) throw new Error('模型分词为空')
    if (encoded.ids.length > ids.length) ids[ids.length - 1] = encoded.ids.at(-1)!
    const tensor = (values: number[]) => new runtime.Tensor('int64', BigInt64Array.from(values, BigInt), [1, ids.length])
    const output = await this.session!.run({ input_ids: tensor(ids), token_type_ids: tensor(ids.map(() => 0)), position_ids: tensor(ids.map((_, i) => i)) })
    const vector = Array.from(output.sentence_embedding!.data as Float32Array)
    if (vector.length !== this.dimension || vector.some(v => !Number.isFinite(v)) || Math.abs(vector.reduce((n, v) => n + v * v, 0) - 1) > 0.001)
      throw new Error('BGE 返回了无效向量')
    return vector
  }
  async close(): Promise<void> { await this.loading?.catch(() => {}); await this.session?.release(); this.session = undefined; this.loading = undefined }
}
