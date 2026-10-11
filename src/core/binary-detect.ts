export const BINARY_EXTENSIONS = new Set([
  '.png', '.jpg', '.jpeg', '.gif', '.bmp', '.ico',
  '.woff', '.woff2', '.ttf', '.eot',
  '.mp3', '.mp4', '.wav',
  '.zip', '.tar', '.gz', '.7z', '.rar',
  '.exe', '.dll', '.so', '.dylib', '.o',
  '.pyc', '.class', '.wasm', '.pdf',
]);

export function isBinaryFile(filePath: string, content?: Buffer): boolean {
  const ext = filePath.slice(filePath.lastIndexOf('.')).toLowerCase();
  if (BINARY_EXTENSIONS.has(ext)) {
    return true;
  }

  if (content) {
    const checkLength = Math.min(content.length, 8192);
    for (let i = 0; i < checkLength; i++) {
      if (content[i] === 0) {
        return true;
      }
    }
  }

  return false;
}
