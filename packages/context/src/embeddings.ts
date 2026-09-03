/**
 * Embedding providers — docs/09 §7.
 *
 * Provider-independent, and the dimension is fixed per installation. Mixing dimensions silently
 * is a classic and painful bug, so the store asserts the configured dimension at startup rather
 * than discovering the mismatch during a retrieval.
 */

import { createHash } from 'node:crypto';

export interface EmbeddingProvider {
  readonly model: string;
  readonly dimensions: number;
  embed(texts: string[]): Promise<number[][]>;
}

/**
 * Deterministic hash embedder. Not semantically meaningful, but stable and free — which is what
 * demo mode and the test suite need. Retrieval still exercises the real SQL path and the real
 * packing logic; only the ranking is arbitrary.
 */
export class HashEmbeddingProvider implements EmbeddingProvider {
  readonly model = 'hash-deterministic';

  constructor(readonly dimensions = 1536) {}

  async embed(texts: string[]): Promise<number[][]> {
    return texts.map((text) => this.embedOne(text));
  }

  private embedOne(text: string): number[] {
    const vector = new Array<number>(this.dimensions).fill(0);
    // Bag-of-tokens hashing: repeated tokens reinforce the same dimensions, so identical text
    // yields identical vectors and near-identical text yields near vectors.
    for (const token of text.toLowerCase().split(/\W+/).filter(Boolean)) {
      const digest = createHash('sha256').update(token).digest();
      for (let i = 0; i < 8; i += 1) {
        const index = digest.readUInt16BE(i * 2) % this.dimensions;
        const sign = (digest[16 + i] ?? 0) % 2 === 0 ? 1 : -1;
        vector[index] = (vector[index] ?? 0) + sign;
      }
    }
    const norm = Math.sqrt(vector.reduce((sum, v) => sum + v * v, 0)) || 1;
    return vector.map((v) => v / norm);
  }
}

/** OpenAI-compatible embeddings — also covers Ollama and any compatible local server. */
export class OpenAICompatibleEmbeddingProvider implements EmbeddingProvider {
  constructor(
    readonly model: string,
    readonly dimensions: number,
    private readonly options: { baseUrl: string; apiKey?: string; batchSize?: number },
  ) {}

  async embed(texts: string[]): Promise<number[][]> {
    const batchSize = this.options.batchSize ?? 64;
    const out: number[][] = [];

    for (let i = 0; i < texts.length; i += batchSize) {
      const batch = texts.slice(i, i + batchSize);
      const response = await fetch(`${this.options.baseUrl.replace(/\/$/, '')}/embeddings`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          ...(this.options.apiKey ? { authorization: `Bearer ${this.options.apiKey}` } : {}),
        },
        body: JSON.stringify({ model: this.model, input: batch }),
      });

      if (!response.ok) {
        throw new Error(`embedding request failed: ${response.status} ${await response.text()}`);
      }

      const payload = (await response.json()) as { data: { embedding: number[] }[] };
      for (const item of payload.data) {
        if (item.embedding.length !== this.dimensions) {
          throw new Error(
            `embedding dimension mismatch: model returned ${item.embedding.length}, ` +
              `installation is configured for ${this.dimensions}`,
          );
        }
        out.push(item.embedding);
      }
    }
    return out;
  }
}

/** Split prose on headings, then to a token budget with overlap (docs/09 §7). */
export function chunkDocument(
  content: string,
  options: { maxTokens?: number; overlapTokens?: number } = {},
): { content: string; startChar: number; endChar: number; tokenCount: number }[] {
  const maxTokens = options.maxTokens ?? 800;
  const overlapTokens = options.overlapTokens ?? 100;
  const charsPerToken = 3.4;
  const maxChars = Math.floor(maxTokens * charsPerToken);
  const overlapChars = Math.floor(overlapTokens * charsPerToken);

  const sections: { text: string; start: number }[] = [];
  const headingSplit = /^#{1,6}\s.+$/gm;
  let lastIndex = 0;
  for (const match of content.matchAll(headingSplit)) {
    if (match.index === undefined || match.index === 0) continue;
    sections.push({ text: content.slice(lastIndex, match.index), start: lastIndex });
    lastIndex = match.index;
  }
  sections.push({ text: content.slice(lastIndex), start: lastIndex });

  const chunks: { content: string; startChar: number; endChar: number; tokenCount: number }[] = [];
  for (const section of sections) {
    if (!section.text.trim()) continue;
    if (section.text.length <= maxChars) {
      chunks.push({
        content: section.text.trim(),
        startChar: section.start,
        endChar: section.start + section.text.length,
        tokenCount: Math.ceil(section.text.length / charsPerToken),
      });
      continue;
    }
    for (let offset = 0; offset < section.text.length; offset += maxChars - overlapChars) {
      const slice = section.text.slice(offset, offset + maxChars);
      if (!slice.trim()) continue;
      chunks.push({
        content: slice.trim(),
        startChar: section.start + offset,
        endChar: section.start + offset + slice.length,
        tokenCount: Math.ceil(slice.length / charsPerToken),
      });
    }
  }
  return chunks;
}
