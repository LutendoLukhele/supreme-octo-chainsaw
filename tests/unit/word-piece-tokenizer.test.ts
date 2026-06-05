import { WordPieceTokenizer } from '../../src/services/intent/WordPieceTokenizer';

describe('WordPieceTokenizer', () => {
  const tokenizer = new WordPieceTokenizer({
    model: {
      vocab: {
        '[PAD]': 0,
        '[UNK]': 1,
        '[CLS]': 2,
        '[SEP]': 3,
        find: 4,
        warm: 5,
        deal: 6,
        '##s': 7,
        '!': 8,
      },
      unk_token: '[UNK]',
    },
  });

  it('lowercases, wordpieces, and pads DistilBERT-style inputs', () => {
    const encoded = tokenizer.encode('Find warm deals!', 8);

    expect(encoded.tokens).toEqual(['[CLS]', 'find', 'warm', 'deal', '##s', '!', '[SEP]', '[PAD]']);
    expect(encoded.inputIds).toEqual([2n, 4n, 5n, 6n, 7n, 8n, 3n, 0n]);
    expect(encoded.attentionMask).toEqual([1n, 1n, 1n, 1n, 1n, 1n, 1n, 0n]);
    expect(encoded.wordIds).toEqual([null, 0, 1, 2, 2, 3, null, null]);
  });

  it('uses the unknown token when a word cannot be decomposed', () => {
    const encoded = tokenizer.encode('mystery', 4);

    expect(encoded.tokens).toEqual(['[CLS]', '[UNK]', '[SEP]', '[PAD]']);
  });
});
