import { createClient, RedisClientType } from 'redis';
import { logger } from './logger';
import { metrics } from './metrics';
import { retry } from './helpers';

interface CacheConfig {
  url: string;
  ttl?: number;
  maxRetries?: number;
  retryDelay?: number;
}

export class CacheService {
  private client: RedisClientType;
  private config: CacheConfig;
  private connected: boolean;

  constructor(config: CacheConfig) {
    this.config = {
      ttl: 3600,
      maxRetries: 5,
      retryDelay: 1000,
      ...config
    };

    this.client = createClient({
      url: this.config.url,
      socket: {
        reconnectStrategy: (attempts) => 
          Math.min(attempts * this.config.retryDelay!, 10000)
      }
    });

    this.connected = false;
    this.setupEventListeners();
  }

  private setupEventListeners() {
    this.client.on('connect', () => {
      this.connected = true;
      logger.info('Redis connected');
    });

    this.client.on('error', (err) => {
      logger.error('Redis error:', err);
      this.connected = false;
    });

    this.client.on('reconnecting', () => {
      logger.warn('Redis reconnecting...');
    });
  }

  async connect(): Promise<void> {
    if (this.connected) return;
    
    await retry(
      async () => {
        await this.client.connect();
        this.connected = true;
      },
      this.config.maxRetries!,
      this.config.retryDelay!,
      'Redis connection'
    );
  }

  async get<T>(key: string): Promise<T | null> {
    try {
      const data = await this.client.get(key);
      metrics.incrementCacheRequest('get', data ? 'hit' : 'miss');
      
      return data ? JSON.parse(data) : null;
    } catch (error) {
      logger.error('Cache get error:', error);
      metrics.incrementCacheError();
      return null;
    }
  }

  async set<T>(
    key: string,
    value: T,
    ttl?: number
  ): Promise<boolean> {
    try {
      const serialized = JSON.stringify(value);
      const options = {
        EX: ttl ?? this.config.ttl
      };

      await this.client.set(key, serialized, options);
      metrics.incrementCacheRequest('set', 'success');
      return true;
    } catch (error) {
      logger.error('Cache set error:', error);
      metrics.incrementCacheError();
      return false;
    }
  }

  async delete(key: string): Promise<boolean> {
    try {
      const result = await this.client.del(key);
      metrics.incrementCacheRequest('delete', result ? 'success' : 'miss');
      return result > 0;
    } catch (error) {
      logger.error('Cache delete error:', error);
      metrics.incrementCacheError();
      return false;
    }
  }

  async flushAll(): Promise<number> {
    try {
      const result = await this.client.flushAll();
      metrics.incrementCacheRequest('flush', 'success');
      return result === 'OK' ? 1 : 0;
    } catch (error) {
      logger.error('Cache flush error:', error);
      metrics.incrementCacheError();
      return 0;
    }
  }

  async keys(pattern: string = '*'): Promise<string[]> {
    try {
      return await this.client.keys(pattern);
    } catch (error) {
      logger.error('Cache keys error:', error);
      return [];
    }
  }

  async pipeline(operations: Array<{
    type: 'get' | 'set' | 'del';
    key: string;
    value?: any;
    ttl?: number;
  }>): Promise<Array<any>> {
    const pipeline = this.client.multi();

    for (const op of operations) {
      switch (op.type) {
        case 'get':
          pipeline.get(op.key);
          break;
        case 'set':
          pipeline.set(op.key, JSON.stringify(op.value), { EX: op.ttl });
          break;
        case 'del':
          pipeline.del(op.key);
          break;
      }
    }

    try {
      const results = await pipeline.exec();
      return results || [];
    } catch (error) {
      logger.error('Cache pipeline error:', error);
      return [];
    }
  }

  async healthCheck(): Promise<boolean> {
    try {
      await this.client.ping();
      return true;
    } catch (error) {
      return false;
    }
  }

  async disconnect(): Promise<void> {
    if (this.connected) {
      await this.client.quit();
      this.connected = false;
    }
  }
}

// Uso recomendado (singleton)
const cacheService = new CacheService({
  url: process.env.REDIS_URL!,
  ttl: parseInt(process.env.CACHE_TTL || '3600')
});

export default cacheService;