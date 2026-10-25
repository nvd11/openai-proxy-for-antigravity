/**
 * Models route - Lists available models
 * GET /v1/models
 */

import type { FastifyInstance } from 'fastify';

const AVAILABLE_MODELS = [
  {
    id: 'antigravity-gemini-3.8-flash',
    object: 'model',
    created: 1700000000,
    owned_by: 'google-antigravity',
  },
  {
    id: 'antigravity-gemini-3.8-flash-medium',
    object: 'model',
    created: 1700000000,
    owned_by: 'google-antigravity',
  },
  {
    id: 'antigravity-gemini-3.8-flash-low',
    object: 'model',
    created: 1700000000,
    owned_by: 'google-antigravity',
  },
  {
    id: 'antigravity-gemini-3.8-flash-high',
    object: 'model',
    created: 1700000000,
    owned_by: 'google-antigravity',
  },
  {
    id: 'gemini-3.8-flash',
    object: 'model',
    created: 1700000000,
    owned_by: 'google-antigravity',
  },
  {
    id: 'gemini-3.8-flash-medium',
    object: 'model',
    created: 1700000000,
    owned_by: 'google-antigravity',
  },
  {
    id: 'antigravity-gemini-3-flash',
    object: 'model',
    created: 1700000000,
    owned_by: 'google-antigravity',
  },
  {
    id: 'antigravity-claude-sonnet-4-6',
    object: 'model',
    created: 1700000000,
    owned_by: 'google-antigravity',
  },
  {
    id: 'antigravity-claude-opus-4-6-thinking',
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
    id: 'antigravity-gpt-oss-120b-medium',
    object: 'model',
    created: 1700000000,
    owned_by: 'google-antigravity',
  },
  {
    id: 'antigravity-gemini-3.5-flash-lite',
    object: 'model',
    created: 1700000000,
    owned_by: 'google-antigravity',
  },
  {
    id: 'antigravity-gemini-3-pro',
    object: 'model',
    created: 1700000000,
    owned_by: 'google-antigravity',
  },
  {
    id: 'antigravity-claude-sonnet-4-5',
    object: 'model',
    created: 1700000000,
    owned_by: 'google-antigravity',
  },
  {
    id: 'antigravity-claude-sonnet-4-5-thinking',
    object: 'model',
    created: 1700000000,
    owned_by: 'google-antigravity',
  },
  {
    id: 'antigravity-claude-opus-4-5-thinking',
    object: 'model',
    created: 1700000000,
    owned_by: 'google-antigravity',
  },
  {
    id: 'gemini-2.5-flash',
    object: 'model',
    created: 1700000000,
    owned_by: 'google-gemini-cli',
  },
  {
    id: 'gemini-2.5-pro',
    object: 'model',
    created: 1700000000,
    owned_by: 'google-gemini-cli',
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
