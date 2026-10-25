/**
 * Models route - Lists available models
 * GET /v1/models
 */

import type { FastifyInstance } from 'fastify';

const AVAILABLE_MODELS = [
  {
    id: 'gemini-3.8-flash',
    object: 'model',
    created: 1700000000,
    owned_by: 'google-antigravity',
  },
  {
    id: 'claude-sonnet-4-6',
    object: 'model',
    created: 1700000000,
    owned_by: 'google-antigravity',
  },
  {
    id: 'claude-opus-4-6-thinking',
    object: 'model',
    created: 1700000000,
    owned_by: 'google-antigravity',
  },
  {
    id: 'gpt-oss-120b-medium',
    object: 'model',
    created: 1700000000,
    owned_by: 'google-antigravity',
  },
];

export default async function modelsRoutes(server: FastifyInstance) {
  server.get('/models', async () => {
    return {
      object: 'list',
      data: AVAILABLE_MODELS,
    };
  });

  server.get('/models/:model', async (request: any) => {
    const model = AVAILABLE_MODELS.find(m => m.id === request.params.model);
    
    if (!model) {
      return {
        error: {
          message: 'Model not found',
          type: 'invalid_request_error',
        },
      };
    }

    return model;
  });
}
