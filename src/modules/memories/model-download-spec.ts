/** Official upstream snapshot, independent of the locally converted Core resource. */
export const memoryModelDownload = {
  baseUrl: 'https://huggingface.co/BAAI/bge-small-zh-v1.5/resolve/7999e1d3359715c523056ef9478215996d62a620/',
  files: [
    { path: 'config.json', bytes: 776, sha256: '3853a7979202c348751b753e36f579c41d8da7d36af617d3d907e1fc9b441f2a' },
    { path: '1_Pooling/config.json', bytes: 190, sha256: 'aaa8861589f80c961a03cc86c7eeaef7605c1676b9ab55329d33a304738769c6' },
    { path: 'tokenizer.json', bytes: 439125, sha256: '48cea5d44424912a6fd1ea647bf4fe50b55ab8b1e5879c3275f80e339e8fae26' },
    { path: 'model.safetensors', bytes: 95827648, sha256: '354763b9b1357bc9c44f62c6be2276321081ed2567773608c0d0785b61d5a026' },
    { path: 'README.md', bytes: 27670, sha256: 'c48a4eeea77f6b1d38b48ec1c5b8d4f86d5550cc43fa345a0db1b2ca1d082369' },
  ],
}
export type MemoryModelDownload = typeof memoryModelDownload
