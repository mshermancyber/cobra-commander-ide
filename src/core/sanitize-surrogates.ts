const UNPAIRED_SURROGATES = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g;

export function sanitizeSurrogates(text: string): string {
  return text.replace(UNPAIRED_SURROGATES, '�');
}
