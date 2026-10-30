import proto from 'onnx-proto'
import type { onnx } from 'onnx-proto'

export interface BertConfig {
  model_type: string; hidden_act: string; hidden_size: number; num_hidden_layers: number
  num_attention_heads: number; intermediate_size: number; layer_norm_eps: number
  max_position_embeddings: number; pad_token_id: number; position_embedding_type?: string | undefined
}
interface Weight { dtype: string; shape: number[]; data_offsets: [number, number] }

/** Encode the supplied BERT safetensors as standard ONNX operators; no Python exporter or Rust process. */
export function bertGraph(weights: Buffer, config: BertConfig): Uint8Array {
  const headerLength = Number(weights.readBigUInt64LE(0))
  if (!Number.isSafeInteger(headerLength) || headerLength < 2 || headerLength > 16 * 1024 * 1024) throw new Error('模型权重头无效')
  const header = JSON.parse(weights.subarray(8, 8 + headerLength).toString('utf8')) as Record<string, Weight>
  const nodes: onnx.INodeProto[] = [], tensors: onnx.ITensorProto[] = []
  let sequence = 0
  const op = (opType: string, input: string[], attribute: onnx.IAttributeProto[] = []) => {
    const name = `v${sequence++}`; nodes.push({ opType, input, output: [name], attribute }); return name
  }
  const integer = (name: string, i: number): onnx.IAttributeProto => ({ name, type: 2, i })
  const integers = (name: string, ints: number[]): onnx.IAttributeProto => ({ name, type: 7, ints })
  const float = (name: string, f: number): onnx.IAttributeProto => ({ name, type: 1, f })
  const constant = (data: number[], dims: number[] = [data.length], int64 = true) => {
    const name = `c${sequence++}`
    tensors.push({ name, dims, dataType: int64 ? 7 : 1, ...(int64 ? { int64Data: data } : { floatData: data }) })
    return name
  }
  const weight = (suffix: string) => {
    const candidates = [suffix, `bert.${suffix}`, suffix.replace('LayerNorm.weight', 'LayerNorm.gamma').replace('LayerNorm.bias', 'LayerNorm.beta')]
    const name = candidates.find(key => header[key])
    if (!name) throw new Error(`模型缺少权重：${suffix}`)
    if (!tensors.some(t => t.name === name)) {
      const item = header[name]!, [start, end] = item.data_offsets, offset = 8 + headerLength
      if (item.dtype !== 'F32' || start < 0 || end < start || offset + end > weights.length
        || end - start !== item.shape.reduce((a, b) => a * b, 1) * 4) throw new Error(`模型权重格式不支持：${name}`)
      tensors.push({ name, dims: item.shape, dataType: 1, rawData: weights.subarray(offset + start, offset + end) })
    }
    return name
  }
  const linear = (value: string, prefix: string) => op('Add', [op('MatMul', [value,
    op('Transpose', [weight(`${prefix}.weight`)], [integers('perm', [1, 0])])]), weight(`${prefix}.bias`)])
  const norm = (value: string, prefix: string) => op('LayerNormalization', [value, weight(`${prefix}.weight`), weight(`${prefix}.bias`)],
    [integer('axis', -1), float('epsilon', config.layer_norm_eps)])
  const transpose = (value: string, perm: number[]) => op('Transpose', [value], [integers('perm', perm)])
  const heads = config.num_attention_heads, width = config.hidden_size / heads
  const headShape = constant([0, 0, heads, width]), fullShape = constant([0, 0, config.hidden_size])
  const gather = (name: string, input: string) => op('Gather', [weight(`embeddings.${name}.weight`), input])
  let value = norm(op('Add', [op('Add', [gather('word_embeddings', 'input_ids'), gather('position_embeddings', 'position_ids')]),
    gather('token_type_embeddings', 'token_type_ids')]), 'embeddings.LayerNorm')
  for (let layer = 0; layer < config.num_hidden_layers; layer++) {
    const prefix = `encoder.layer.${layer}`
    const head = (kind: string) => transpose(op('Reshape', [linear(value, `${prefix}.attention.self.${kind}`), headShape]), [0, 2, 1, 3])
    const query = head('query'), key = head('key'), attentionValue = head('value')
    const scores = op('Div', [op('MatMul', [query, transpose(key, [0, 1, 3, 2])]), constant([Math.sqrt(width)], [], false)])
    const attention = op('Softmax', [scores], [integer('axis', -1)])
    const context = op('Reshape', [transpose(op('MatMul', [attention, attentionValue]), [0, 2, 1, 3]), fullShape])
    value = norm(op('Add', [value, linear(context, `${prefix}.attention.output.dense`)]), `${prefix}.attention.output.LayerNorm`)
    const intermediate = linear(value, `${prefix}.intermediate.dense`)
    const erf = op('Erf', [op('Div', [intermediate, constant([Math.SQRT2], [], false)])])
    const gelu = op('Mul', [intermediate, op('Mul', [op('Add', [erf, constant([1], [], false)]), constant([0.5], [], false)])])
    value = norm(op('Add', [value, linear(gelu, `${prefix}.output.dense`)]), `${prefix}.output.LayerNorm`)
  }
  const cls = op('Reshape', [op('Gather', [value, constant([0], [], true)], [integer('axis', 1)]), constant([config.hidden_size])])
  const magnitude = op('ReduceL2', [cls], [integers('axes', [0]), integer('keepdims', 1)])
  nodes.push({ opType: 'Div', input: [cls, magnitude], output: ['sentence_embedding'] })
  const input = ['input_ids', 'token_type_ids', 'position_ids'].map(name => ({ name,
    type: { tensorType: { elemType: 7, shape: { dim: [{ dimValue: 1 }, { dimParam: 'sequence' }] } } } }))
  const graph: onnx.IGraphProto = { name: 'eden-bge-cls', node: nodes, initializer: tensors, input,
    output: [{ name: 'sentence_embedding', type: { tensorType: { elemType: 1, shape: { dim: [{ dimValue: config.hidden_size }] } } } }] }
  return proto.onnx.ModelProto.encode({ irVersion: 8, opsetImport: [{ domain: '', version: 17 }], producerName: 'Eden Agent', graph }).finish()
}
