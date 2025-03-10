import { createClient, RedisClientType } from 'redis';
import { logger } from './logger';
import { metrics } from './metrics';
import { retry } from './helpers';

interface FeatureFlagConfig {
  name: string;
  enabled: boolean;
  strategies: FeatureStrategy[];
}

interface FeatureStrategy {
  type: 'userIds' | 'gradualRollout' | 'ipRange' | 'custom';
  percentage?: number;
  users?: string[];
  ips?: string[];
  rule?: (context: FeatureContext) => boolean;
}

interface FeatureContext {
  userId?: string;
  ipAddress?: string;
  userAgent?: string;
  custom?: Record<string, any>;
}

interface FeatureFlagServiceConfig {
  redisUrl: string;
  cacheTTL?: number;
  refreshInterval?: number;
}

export class FeatureFlagService {
  private client: RedisClientType;
  private flags: Map<string, FeatureFlagConfig>;
  private config: FeatureFlagServiceConfig;

  constructor(config: FeatureFlagServiceConfig) {
    this.config = {
      cacheTTL: 300, // 5 minutos
      refreshInterval: 60000, // 1 minuto
      ...config
    };

    this.client = createClient({ url: this.config.redisUrl });
    this.flags = new Map();
    this.setupEventListeners();
  }

  private setupEventListeners() {
    this.client.on('error', (err) => 
      logger.error('Feature Flag Redis error:', err)
    );
  }

  async initialize(): Promise<void> {
    await retry(
      async () => {
        await this.client.connect();
        await this.loadFlags();
        this.startAutoRefresh();
      },
      5,
      1000,
      'Feature Flag Service'
    );
  }

  private async loadFlags(): Promise<void> {
    try {
      const keys = await this.client.keys('feature:*');
      const pipeline = this.client.multi();
      
      keys.forEach(key => pipeline.hGetAll(key));
      const results = await pipeline.exec();
      
      results?.forEach((result, index) => {
        const flag = this.parseFlag(keys[index], result);
        if (flag) this.flags.set(flag.name, flag);
      });

      logger.info(`Loaded ${this.flags.size} feature flags`);
    } catch (error) {
      logger.error('Failed to load feature flags:', error);
    }
  }

  private parseFlag(key: string, data: Record<string, string>): FeatureFlagConfig | null {
    try {
      return {
        name: key.replace('feature:', ''),
        enabled: data.enabled === 'true',
        strategies: JSON.parse(data.strategies || '[]')
      };
    } catch (error) {
      logger.error('Invalid flag format:', key);
      return null;
    }
  }

  private startAutoRefresh(): void {
    setInterval(async () => {
      try {
        await this.loadFlags();
      } catch (error) {
        logger.warn('Failed to refresh feature flags:', error);
      }
    }, this.config.refreshInterval!).unref();
  }

  async isEnabled(
    flagName: string,
    context: FeatureContext = {}
  ): Promise<boolean> {
    const start = Date.now();
    try {
      const flag = await this.getFlag(flagName);
      if (!flag) return false;

      const result = this.evaluateFlag(flag, context);
      metrics.trackFeatureFlagCheck(flagName, result);
      
      return result;
    } catch (error) {
      logger.error('Feature flag evaluation error:', error);
      metrics.trackFeatureFlagError(flagName);
      return false;
    } finally {
      metrics.recordFeatureFlagLatency(Date.now() - start);
    }
  }

  private async getFlag(flagName: string): Promise<FeatureFlagConfig | null> {
    // Verificar cache local primeiro
    if (this.flags.has(flagName)) {
      return this.flags.get(flagName)!;
    }

    // Buscar no Redis se não encontrado
    try {
      const data = await this.client.hGetAll(`feature:${flagName}`);
      const flag = this.parseFlag(`feature:${flagName}`, data);
      
      if (flag) {
        this.flags.set(flagName, flag);
        return flag;
      }
      
      return null;
    } catch (error) {
      throw new Error(`Failed to fetch flag: ${flagName}`);
    }
  }

  private evaluateFlag(flag: FeatureFlagConfig, context: FeatureContext): boolean {
    if (!flag.enabled) return false;
    if (flag.strategies.length === 0) return true;

    return flag.strategies.some(strategy => {
      switch (strategy.type) {
        case 'userIds':
          return strategy.users?.includes(context.userId || '') || false;
          
        case 'gradualRollout':
          return this.checkPercentageRollout(context.userId, strategy.percentage || 0);
          
        case 'ipRange':
          return this.checkIpRange(context.ipAddress || '', strategy.ips || []);
          
        case 'custom':
          return strategy.rule?.(context) || false;
          
        default:
          logger.warn('Unknown strategy type:', strategy.type);
          return false;
      }
    });
  }

  private checkPercentageRollout(userId?: string, percentage: number = 0): boolean {
    if (!userId) return false;
    
    const hash = this.hashString(userId);
    return (hash % 100) < percentage;
  }

  private hashString(str: string): number {
    let hash = 0;
    for (let i = 0; i < str.length; i++) {
      hash = ((hash << 5) - hash) + str.charCodeAt(i);
      hash |= 0; // Converte para inteiro 32bit
    }
    return Math.abs(hash);
  }

  private checkIpRange(ip: string, ranges: string[]): boolean {
    return ranges.some(range => {
      if (range.includes('/')) {
        return this.isIpInCIDR(ip, range);
      }
      return ip === range;
    });
  }

  private isIpInCIDR(ip: string, cidr: string): boolean {
    // Implementação de verificação CIDR omitida para brevidade
    return false;
  }

  async updateFlag(
    flagName: string,
    enabled: boolean,
    strategies: FeatureStrategy[]
  ): Promise<void> {
    const flagKey = `feature:${flagName}`;
    
    await this.client.hSet(flagKey, {
      enabled: enabled.toString(),
      strategies: JSON.stringify(strategies)
    });
    
    await this.client.expire(flagKey, this.config.cacheTTL!);
    await this.loadFlags(); // Atualizar cache local
    
    logger.info(`Updated feature flag: ${flagName}`);
    metrics.trackFeatureFlagUpdate(flagName);
  }

  async deleteFlag(flagName: string): Promise<void> {
    await this.client.del(`feature:${flagName}`);
    this.flags.delete(flagName);
    logger.info(`Deleted feature flag: ${flagName}`);
  }

  async listFlags(): Promise<FeatureFlagConfig[]> {
    return Array.from(this.flags.values());
  }

  async close(): Promise<void> {
    await this.client.quit();
    this.flags.clear();
  }
}

// Uso recomendado (singleton)
const featureFlagService = new FeatureFlagService({
  redisUrl: process.env.REDIS_URL!
});

export default featureFlagService;