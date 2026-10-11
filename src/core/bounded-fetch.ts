export async function collectBoundedBody(
  response: Response,
  maxBytes: number = 500_000,
): Promise<string> {
  const text = await response.text();
  return boundText(text, maxBytes);
}

export function boundText(text: string, maxBytes: number = 500_000): string {
  if (text.length <= maxBytes) {
    return text;
  }
  return text.slice(0, maxBytes) + `\n[truncated at ${maxBytes} bytes]`;
}
