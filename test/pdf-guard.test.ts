import { describe, expect, it } from 'vitest';
import { looksLikePdf } from '../src/lib/asx';

const bytes = (s: string): ArrayBuffer => new TextEncoder().encode(s).buffer as ArrayBuffer;

describe('looksLikePdf', () => {
  it('accepts a real PDF header', () => {
    expect(looksLikePdf(bytes('%PDF-1.7\n%âãÏÓ\n1 0 obj'))).toBe(true);
  });

  it('accepts a header behind a short preamble', () => {
    expect(looksLikePdf(bytes('\n\n   %PDF-1.4 rest of file'))).toBe(true);
  });

  it('rejects the Cloudflare bot challenge that broke the IFM test document', () => {
    // Verbatim opening of the 5,934-byte page that got stored as a PDF.
    const challenge =
      '<!DOCTYPE html><html lang="en-US"><head><title>Just a moment...</title>' +
      '<meta http-equiv="Content-Type" content="text/html; charset=UTF-8">' +
      'window._cf_chl_opt = {cFPWv: \'g\'';
    expect(looksLikePdf(bytes(challenge))).toBe(false);
  });

  it('rejects HTML error pages and JSON', () => {
    expect(looksLikePdf(bytes('<!doctype html><h1>404 Not Found</h1>'))).toBe(false);
    expect(looksLikePdf(bytes('{"error":"unauthorized"}'))).toBe(false);
    expect(looksLikePdf(new ArrayBuffer(0))).toBe(false);
  });

  it('does not find a header buried past the first 1024 bytes', () => {
    expect(looksLikePdf(bytes('x'.repeat(2000) + '%PDF-1.4'))).toBe(false);
  });
});
