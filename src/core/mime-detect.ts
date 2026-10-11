interface MagicSignature {
  bytes: number[];
  offset?: number;
  mime: string;
}

const SIGNATURES: MagicSignature[] = [
  { bytes: [0x89, 0x50, 0x4E, 0x47], mime: 'image/png' },
  { bytes: [0xFF, 0xD8, 0xFF], mime: 'image/jpeg' },
  { bytes: [0x47, 0x49, 0x46, 0x38], mime: 'image/gif' },
  { bytes: [0x25, 0x50, 0x44, 0x46], mime: 'application/pdf' },
  { bytes: [0x50, 0x4B, 0x03, 0x04], mime: 'application/zip' },
  { bytes: [0x1F, 0x8B], mime: 'application/gzip' },
  { bytes: [0x42, 0x4D], mime: 'image/bmp' },
];

export function detectMimeFromBytes(buffer: Buffer): string | null {
  // Check RIFF....WEBP (bytes 0-3 = RIFF, bytes 8-11 = WEBP)
  if (buffer.length >= 12 &&
      buffer[0] === 0x52 && buffer[1] === 0x49 && buffer[2] === 0x46 && buffer[3] === 0x46 &&
      buffer[8] === 0x57 && buffer[9] === 0x45 && buffer[10] === 0x42 && buffer[11] === 0x50) {
    return 'image/webp';
  }

  for (const sig of SIGNATURES) {
    const offset = sig.offset ?? 0;
    if (buffer.length < offset + sig.bytes.length) {
      continue;
    }
    let match = true;
    for (let i = 0; i < sig.bytes.length; i++) {
      if (buffer[offset + i] !== sig.bytes[i]) {
        match = false;
        break;
      }
    }
    if (match) {
      return sig.mime;
    }
  }

  return null;
}
