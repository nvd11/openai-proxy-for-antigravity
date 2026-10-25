/**
 * Chat completions route - OpenAI-compatible endpoint
 * POST /v1/chat/completions
 */

import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { adapter, type OpenAIRequest } from '../adapters/openai-adapter.js';
import { accountService } from '../services/account-manager.js';
import { accessTokenExpired } from '../lib/auth/auth.js';
import { refreshAccessToken } from '../lib/auth/token.js';
import { createLogger } from '../lib/logger.js';
import { metricsService } from '../services/metrics-collector.js';
import { logService } from '../services/log-store.js';

const log = createLogger('chat-route');

interface ChatRequest extends FastifyRequest {
  body: OpenAIRequest;
}

export default async function chatRoutes(server: FastifyInstance) {
  server.post<{ Body: OpenAIRequest }>(
    '/chat/completions',
    async (request: ChatRequest, reply: FastifyReply) => {
      const startTime = Date.now();
      const openaiReq = request.body;

      log.info('⬇️ INCOMING REQUEST FROM CLIENT', {
        headers: request.headers,
        body: JSON.stringify(openaiReq, null, 2),
      });

      try {
        // Validate request
        if (!openaiReq.model) {
          return reply.status(400).send({
            error: {
              message: 'Missing required field: model',
              type: 'invalid_request_error',
            },
          });
        }

        if (!openaiReq.messages || openaiReq.messages.length === 0) {
          return reply.status(400).send({
            error: {
              message: 'Missing required field: messages',
              type: 'invalid_request_error',
            },
          });
        }

        log.info('Chat completion request', {
          model: openaiReq.model,
          messageCount: openaiReq.messages.length,
          stream: openaiReq.stream,
          hasTools: Boolean(openaiReq.tools && openaiReq.tools.length > 0),
        });

        // Failover retry loop across accounts
        const totalAccounts = await accountService.getAccountCount();
        const maxAttempts = Math.max(1, totalAccounts);
        let attempt = 0;
        let response: Response | null = null;
        let lastUrl = '';
        let currentAccount: any = null;

        while (attempt < maxAttempts) {
          attempt++;
          currentAccount = await accountService.getNextAccount(openaiReq.model);

          if (!currentAccount) {
            break;
          }

          // Get auth details from account
          let authRecord = accountService.getAccountManager().then(m => m.toAuthDetails(currentAccount));
          let auth = await authRecord;

          // Refresh token if needed
          if (accessTokenExpired(auth)) {
            log.debug('Access token expired, refreshing...', {
              accountIndex: currentAccount.index,
              email: currentAccount.email,
            });

            const refreshed = await refreshAccessToken(auth);
            if (!refreshed) {
              log.error('Token refresh failed', {
                accountIndex: currentAccount.index,
              });
              continue;
            }

            // Update account with new token
            const manager = await accountService.getAccountManager();
            manager.updateFromAuth(currentAccount, refreshed);
            await manager.saveToDisk();
            auth = refreshed;
          }

          const accessToken = auth.access;
          if (!accessToken) {
            continue;
          }

          // Get projectId
          const projectId = currentAccount.parts.projectId || currentAccount.parts.managedProjectId || 'rising-fact-p41fc';

          // Convert OpenAI request to Antigravity
          const { url, init, headerStyle } = await adapter.convertRequest(
            openaiReq,
            accessToken,
            projectId
          );
          lastUrl = url;

          log.info('Making Antigravity request', {
            url,
            projectId,
            headerStyle,
            accountIndex: currentAccount.index,
            email: currentAccount.email,
            attempt,
          });

          // Make request to Antigravity
          response = await fetch(url, init);

          // Handle rate limits with seamless failover
          if (response.status === 429) {
            log.warn('Rate limited on account, failing over to next account...', {
              accountIndex: currentAccount.index,
              email: currentAccount.email,
              model: openaiReq.model,
            });

            await accountService.markRateLimited(currentAccount, 60_000, openaiReq.model);
            metricsService.recordRequest(openaiReq.model, Date.now() - startTime, 'rate_limited');
            response = null;
            continue;
          }

          // Success or non-429 error received, break retry loop
          break;
        }

        if (!response) {
          return reply.status(429).send({
            error: {
              message: 'All accounts are rate-limited. Please try again later.',
              type: 'rate_limit_error',
            },
          });
        }

        // Handle other errors
        if (!response.ok) {
          const errorText = await response.text().catch(() => '');
          log.error('❌ ANTIGRAVITY API ERROR', {
            status: response.status,
            statusText: response.statusText,
            headers: Object.fromEntries(response.headers.entries()),
            body: errorText.slice(0, 2000), // Log more of the body
            url: lastUrl, // Log the URL that failed
          });

          metricsService.recordRequest(openaiReq.model, Date.now() - startTime, 'error');

          return reply.status(response.status).send({
            error: {
              message: `Antigravity API error: ${response.statusText}. Check server logs for details.`,
              type: 'api_error',
            },
          });
        }

        // Handle streaming response
        if (openaiReq.stream) {
          reply.raw.writeHead(200, {
            'Content-Type': 'text/event-stream',
            'Cache-Control': 'no-cache',
            'Connection': 'keep-alive',
          });

          let streamBuffer = '';

          // Convert and stream
          for await (const chunk of adapter.convertStream(response.body!, openaiReq.model)) {
            streamBuffer += chunk;
            reply.raw.write(chunk);
          }

          reply.raw.end();

          // Record metrics
          const duration = Date.now() - startTime;
          metricsService.recordRequest(openaiReq.model, duration, 'success');
          logService.logRequest(
            openaiReq.model,
            'stream',
            duration,
            'success',
            undefined, // tokens not easily available for stream
            openaiReq,
            streamBuffer
          );

          return;
        }

        // Handle non-streaming response
        const openaiResponse = await adapter.convertResponse(response, openaiReq.model);

        // Record metrics
        const duration = Date.now() - startTime;
        metricsService.recordRequest(openaiReq.model, duration, 'success');
        logService.logRequest(
          openaiReq.model,
          'completion',
          duration,
          'success',
          openaiResponse.usage?.total_tokens,
          openaiReq,
          openaiResponse
        );

        return reply.send(openaiResponse);

      } catch (error) {
        log.error('Chat completion error', {
          error: String(error),
          stack: error instanceof Error ? error.stack : undefined,
        });

        metricsService.recordRequest(openaiReq.model, Date.now() - startTime, 'error');
        logService.logRequest(
          openaiReq.model,
          'completion',
          Date.now() - startTime,
          'error',
          undefined,
          openaiReq,
          { error: String(error) }
        );

        return reply.status(500).send({
          error: {
            message: error instanceof Error ? error.message : 'Internal server error',
            type: 'internal_error',
          },
        });
      }
    }
  );
}
