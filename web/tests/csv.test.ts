import { describe, expect, test } from 'bun:test';
import { parseCsv } from '../ingest/csv.ts';

describe('CSV', () => {
  test('quotes, doubled quotes, embedded commas and newlines, CRLF, BOM', () => {
    const text = '﻿id,name,note\r\n1,"Run, easy","said ""hi""\nthen left"\r\n2,plain,\n';
    expect(parseCsv(text)).toEqual([
      ['id', 'name', 'note'],
      ['1', 'Run, easy', 'said "hi"\nthen left'],
      ['2', 'plain', ''],
    ]);
  });

  test('last line without a newline and empty fields', () => {
    expect(parseCsv('a,b\n,x')).toEqual([['a', 'b'], ['', 'x']]);
    expect(parseCsv('')).toEqual([]);
  });
});
