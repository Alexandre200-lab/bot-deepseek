import { Request, Response } from 'express';
import { Database } from '../config/database';
import { AIService } from '../services/AIService';
import { CacheService } from '../services/CacheService';
import { FeatureFlagService } from '../services/FeatureFlagService';
import { logger } from '../utils/logger';
import { validateAdmin } from '../middleware/auth';
import { metrics } from '../utils/metrics';
import { 
  UserFilterParams,
  ChatStatistics,
  SystemStatus,
  FeatureFlagUpdate
} from '../types/admin';

export class AdminController {
  constructor(
    private readonly featureFlags: FeatureFlagService,
    private readonly aiService: AIService,
    private readonly cacheService: CacheService
  ) {}

  // Middleware de autorização administrativa
  static adminAuth = [validateAdmin];

  /**
   * @route GET /admin/users
   * @desc Lista usuários com filtros e paginação
   */
  async listUsers(req: Request, res: Response) {
    try {
      const { 
        page = 1, 
        limit = 50,
        role,
        search,
        sortBy = 'created_at',
        sortOrder = 'desc'
      } = req.query as UserFilterParams;

      const offset = (Number(page) - 1) * Number(limit);
      
      const query = Database.instance('users')
        .select('id', 'email', 'role', 'created_at', 'last_login')
        .orderBy(sortBy, sortOrder)
        .offset(offset)
        .limit(Number(limit));

      if (role) query.where('role', role);
      if (search) {
        query.where(function() {
          this.where('email', 'ilike', `%${search}%`)
            .orWhere('id', 'ilike', `%${search}%`);
        });
      }

      const users = await query;
      const total = await Database.instance('users').count('id').first();

      res.json({
        data: users,
        meta: {
          total: Number(total?.count),
          page: Number(page),
          limit: Number(limit),
          totalPages: Math.ceil(Number(total?.count) / Number(limit))
        }
      });
    } catch (error) {
      logger.error('Admin user list error:', error);
      res.status(500).json({ error: 'Failed to fetch users' });
    }
  }

  /**
   * @route GET /admin/analytics/chats
   * @desc Obtém estatísticas detalhadas de chats
   */
  async getChatAnalytics(req: Request, res: Response) {
    try {
      const stats: ChatStatistics = {
        activeChats: await this.getActiveChatCount(),
        avgResponseTime: await this.getAverageResponseTime(),
        messagesPerHour: await this.getMessagesPerHour(),
        popularIntents: await this.getPopularIntents(),
        userSatisfaction: await this.getSatisfactionScore()
      };

      res.json(stats);
    } catch (error) {
      logger.error('Chat analytics error:', error);
      res.status(500).json({ error: 'Failed to get analytics' });
    }
  }

  /**
   * @route GET /admin/system/status
   * @desc Verifica status do sistema
   */
  async getSystemStatus(req: Request, res: Response) {
    try {
      const status: SystemStatus = {
        database: await Database.healthCheck(),
        redis: await this.cacheService.ping(),
        aiService: await this.aiService.healthCheck(),
        featureFlags: this.featureFlags.status(),
        uptime: process.uptime(),
        memoryUsage: process.memoryUsage(),
        loadAvg: process.loadavg()
      };

      res.json(status);
    } catch (error) {
      logger.error('System status check error:', error);
      res.status(500).json({ error: 'Failed to check system status' });
    }
  }

  /**
   * @route POST /admin/features
   * @desc Atualiza feature flags
   */
  async updateFeatureFlags(req: Request, res: Response) {
    try {
      const updates: FeatureFlagUpdate[] = req.body;
      
      await Promise.all(updates.map(async (flag) => {
        await this.featureFlags.updateFlag(
          flag.name,
          flag.enabled,
          flag.strategies
        );
      }));

      res.json({ 
        message: 'Feature flags updated',
        updatedFlags: updates.map(f => f.name) 
      });
    } catch (error) {
      logger.error('Feature flag update error:', error);
      res.status(400).json({ error: 'Invalid feature flag configuration' });
    }
  }

  /**
   * @route DELETE /admin/cache
   * @desc Limpa cache do sistema
   */
  async flushCache(req: Request, res: Response) {
    try {
      const result = await this.cacheService.flushAll();
      metrics.reset();
      
      res.json({
        message: 'Cache flushed successfully',
        keysRemoved: result
      });
    } catch (error) {
      logger.error('Cache flush error:', error);
      res.status(500).json({ error: 'Failed to flush cache' });
    }
  }

  // Métodos auxiliares
  private async getActiveChatCount(): Promise<number> {
    return Database.instance('sessions')
      .where('expires_at', '>', Database.instance.fn.now())
      .count('id')
      .first()
      .then(res => Number(res?.count));
  }

  private async getAverageResponseTime(): Promise<number> {
    return Database.instance('messages')
      .where('is_bot', true)
      .avg('response_time')
      .first()
      .then(res => Number(res?.avg) || 0);
  }

  private async getMessagesPerHour(): Promise<number> {
    return Database.instance.raw(`
      SELECT COUNT(*) / 24 AS messages_per_hour 
      FROM messages 
      WHERE created_at >= NOW() - INTERVAL '1 DAY'
    `).then(res => Number(res.rows[0]?.messages_per_hour) || 0);
  }

  private async getPopularIntents(limit = 5): Promise<Array<{intent: string; count: number}>> {
    return Database.instance('messages')
      .select('intent')
      .count('* as count')
      .whereNotNull('intent')
      .groupBy('intent')
      .orderBy('count', 'desc')
      .limit(limit);
  }

  private async getSatisfactionScore(): Promise<number> {
    return Database.instance('feedback')
      .avg('rating')
      .first()
      .then(res => Number(res?.avg) || 0);
  }
}