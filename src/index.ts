import app from './app';
import { config } from './lib/config';
import serverless from 'serverless-http';

export const handler = serverless(app);

// Local dev only — Lambda does not bind a port (the handler is the entry).
if (!process.env.AWS_LAMBDA_FUNCTION_NAME) {
  app.listen(config.port, () => {
    console.log(`StoreLah CMS listening on http://localhost:${config.port}`);
  });
}
