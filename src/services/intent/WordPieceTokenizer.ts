interface TokenizerJson {
  model: {
    vocab: Record<string, number>;
    unk_token?: string;
  };
}

export interface EncodedWordPieceInput {
  inputIds: bigint[];
  attentionMask: bigint[];
  tokens: string[];
  words: string[];
  wordIds: Array<number | null>;
}

/**
 * Minimal DistilBERT-compatible tokenizer for runtime inference.
 *
 * The trained artifacts already ship `tokenizer.json`; using it directly keeps
 * inference self-contained in Node without adding another native tokenizer
 * dependency just to recover known ASO workflow frames.
 */
export class WordPieceTokenizer {
  private readonly vocab: Map<string, number>;
  private readonly unkToken: string;
  private readonly padId: number;
  private readonly clsId: number;
  private readonly sepId: number;
  private readonly unkId: number;

  constructor(tokenizerJson: TokenizerJson) {
    this.vocab = new Map(Object.entries(tokenizerJson.model.vocab));
    this.unkToken = tokenizerJson.model.unk_token ?? '[UNK]';
    this.padId = this.idFor('[PAD]');
    this.clsId = this.idFor('[CLS]');
    this.sepId = this.idFor('[SEP]');
    this.unkId = this.idFor(this.unkToken);
  }

  encode(text: string, maxLength = 128): EncodedWordPieceInput {
    const words = this.preTokenize(text);
    const tokens: string[] = ['[CLS]'];
    const wordIds: Array<number | null> = [null];

    words.forEach((word, wordIndex) => {
      for (const piece of this.wordPiece(word)) {
        if (tokens.length >= maxLength - 1) break;
        tokens.push(piece);
        wordIds.push(wordIndex);
      }
    });

    tokens.push('[SEP]');
    wordIds.push(null);

    const inputIds = tokens.map((token) => BigInt(this.vocab.get(token) ?? this.unkId));
    const attentionMask = tokens.map(() => 1n);

    while (inputIds.length < maxLength) {
      inputIds.push(BigInt(this.padId));
      attentionMask.push(0n);
      tokens.push('[PAD]');
      wordIds.push(null);
    }

    return {
      inputIds: inputIds.slice(0, maxLength),
      attentionMask: attentionMask.slice(0, maxLength),
      tokens: tokens.slice(0, maxLength),
      words,
      wordIds: wordIds.slice(0, maxLength),
    };
  }

  private idFor(token: string): number {
    const id = this.vocab.get(token);
    if (id === undefined) {
      throw new Error(`Tokenizer vocabulary is missing required token: ${token}`);
    }
    return id;
  }

  private preTokenize(text: string): string[] {
    const normalized = text
      .normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '')
      .toLowerCase();
    return normalized.match(/[a-z0-9]+|[^\s\p{L}\p{N}]/gu) ?? [];
  }

  private wordPiece(word: string): string[] {
    if (this.vocab.has(word)) return [word];
    if (word.length > 100) return [this.unkToken];

    const pieces: string[] = [];
    let start = 0;
    while (start < word.length) {
      let end = word.length;
      let current: string | null = null;
      while (start < end) {
        const substring = word.slice(start, end);
        const candidate = start === 0 ? substring : `##${substring}`;
        if (this.vocab.has(candidate)) {
          current = candidate;
          break;
        }
        end -= 1;
      }
      if (!current) return [this.unkToken];
      pieces.push(current);
      start = end;
    }
    return pieces;
  }
}
