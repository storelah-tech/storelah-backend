import app from './app';
import { config } from './lib/config';
import serverless from 'serverless-http';

// Response content types serverless-http must return base64-encoded
// (isBase64Encoded) so API Gateway (HTTP API v2) decodes them back to the
// exact bytes. Without this, serverless-http stringifies every body as UTF-8
// and binary downloads (financial report / quotation / invoice / receipt
// PDFs, uploaded media) arrive corrupted — every non-ASCII byte becomes
// EF BF BD and the PDF will not open. Local `app.listen` is unaffected.
export const BINARY_CONTENT_TYPES = [
  'application/pdf',
  'application/octet-stream',
  'application/zip',
  'image/*',
  'video/*',
  'audio/*',
  'font/*',
];

export const handler = serverless(app, { binary: BINARY_CONTENT_TYPES });

// Local dev only — Lambda does not bind a port (the handler is the entry).
if (!process.env.AWS_LAMBDA_FUNCTION_NAME) {
  app.listen(config.port, () => {
    console.log(`StoreLah CMS listening on http://localhost:${config.port}`);
  });
}
