/**
 * Account Manager Service
 * Manages OAuth accounts, rotation, and rate limiting
 */

import { AccountManager, type ManagedAccount } from '../lib/auth/accounts.js';
import { formatRefreshParts } from '../lib/auth/auth.js';
import { loadAccounts } from '../lib/auth/storage.js';
import { createLogger } from '../lib/logger.js';
import type { OAuthAuthDetails } from '../lib/types.js';
import { adapter } from '../adapters/openai-adapter.js';

const log = createLogger('account-service');

export class AccountService {
  private accountManager: AccountManager | null = null;
  private initialized = false;

  async initialize(): Promise<void> {
    if (this.initialized) return;

    try {
      // Load accounts from disk
      const stored = await loadAccounts();
      
      if (!stored || !stored.accounts || stored.accounts.length === 0) {
        log.warn('No accounts found. Run authentication first.');
        this.initialized = true;
        return;
      }

      // Create a dummy auth object from the first account to initialize AccountManager
      const firstAccount = stored.accounts[0];
      if (!firstAccount) {
        throw new Error('No valid account found');
      }

      const dummyAuth: OAuthAuthDetails = {
        type: 'oauth',
        refresh: formatRefreshParts({
          refreshToken: firstAccount.refreshToken,
          projectId: firstAccount.projectId,
          managedProjectId: firstAccount.managedProjectId,
        }),
        access: '', // Will be refreshed when needed
        expires: 0,
      };

      this.accountManager = await AccountManager.loadFromDisk(dummyAuth);
      this.initialized = true;

      log.info('Account manager initialized', {
        accountCount: this.accountManager.getAccountCount(),
      });
    } catch (error) {
      log.error('Failed to initialize account manager', {
        error: String(error),
      });
      throw error;
    }
  }

  async getAccountManager(): Promise<AccountManager> {
    if (!this.initialized) {
      await this.initialize();
    }

    if (!this.accountManager) {
      throw new Error('Account manager not initialized. Run authentication first.');
    }

    return this.accountManager;
  }

  async getAccountCount(): Promise<number> {
    const manager = await this.getAccountManager();
    return manager.getAccountCount();
  }

  async getAccounts(): Promise<ManagedAccount[]> {
    const manager = await this.getAccountManager();
    return manager.getAccounts();
  }

  async getNextAccount(model: string): Promise<ManagedAccount | null> {
    const manager = await this.getAccountManager();
    
    // Determine model family from model name
    const family = model.toLowerCase().includes('claude') ? 'claude' : 'gemini';
    const headerStyle = adapter.getHeaderStyle(model);
    const strategy = (process.env.ROTATION_STRATEGY as any) || 'round-robin';

    return manager.getCurrentOrNextForFamily(
      family as 'claude' | 'gemini',
      model,
      strategy,
      headerStyle,
      false, // pid_offset_enabled
    );
  }

  async markRateLimited(account: ManagedAccount, delayMs: number, model: string): Promise<void> {
    const manager = await this.getAccountManager();
    const family = model.toLowerCase().includes('claude') ? 'claude' : 'gemini';
    const headerStyle = adapter.getHeaderStyle(model);

    manager.markRateLimited(
      account,
      delayMs,
      family as 'claude' | 'gemini',
      headerStyle,
      model
    );

    await manager.saveToDisk();
  }

  async saveToDisk(): Promise<void> {
    if (this.accountManager) {
      await this.accountManager.saveToDisk();
    }
  }
}

// Singleton instance
export const accountService = new AccountService();
