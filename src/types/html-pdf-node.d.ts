declare module 'html-pdf-node' {
  interface PDFOptions {
    format?: string;
    margin?: {
      top?: string;
      bottom?: string;
      left?: string;
      right?: string;
    };
    path?: string;
    printBackground?: boolean;
    [key: string]: unknown;
  }

  interface File {
    content?: string;
    url?: string;
  }

  export function generate(
    file: File,
    options?: PDFOptions,
  ): Promise<Buffer | Uint8Array>;
}
