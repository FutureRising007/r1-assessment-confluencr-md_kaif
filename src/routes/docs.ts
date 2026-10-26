import fs from 'fs';
import path from 'path';
import { Router } from 'express';
import swaggerUi from 'swagger-ui-express';
import YAML from 'yaml';

const SPEC_PATH = path.join(__dirname, '..', '..', 'docs', 'openapi.yaml');

/** Serves interactive Swagger UI at /docs and the raw spec at /docs/openapi.json. */
export function docsRouter(): Router {
  const router = Router();
  const spec = YAML.parse(fs.readFileSync(SPEC_PATH, 'utf8'));
  router.get('/openapi.json', (_req, res) => {
    res.json(spec);
  });
  router.use('/', swaggerUi.serve, swaggerUi.setup(spec));
  return router;
}
