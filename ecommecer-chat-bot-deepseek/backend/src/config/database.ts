import { knex, Knex } from 'knex';
import { createClient } from 'redis';
import { logger } from '../utils/logger';
import { retry } from '../utils/helpers';

interface DatabaseConfig {
  client: string;
  connection: {
    host: string;
    port: number;
    user: string;
    password: string;
    database: string;
    ssl?: { rejectUnauthorized: boolean };
  };
  pool: {
    min: number;
    max: number;
    acquireTimeoutMillis: number;
    idleTimeoutMillis: number;
  };
  migrations: {
    tableName: string;
    directory: string;
    extension: string;
  };
  seeds?: {
    directory: string;
  };
}

export class Database {
  private static instance: Knex;
  private static redisClient: ReturnType<typeof createClient>;

  private constructor() {}

  static get config(): DatabaseConfig {
    return {
      client: 'pg',
      connection: {
        host: process.env.DB_HOST || 'localhost',
        port: parseInt(process.env.DB_PORT || '5432'),
        user: process.env.DB_USER || 'postgres',
        password: process.env.DB_PASSWORD || 'postgres',
        database: process.env.DB_NAME || 'ecommerce_chat',
        ssl: process.env.DB_SSL === 'true' ? { 
          rejectUnauthorized: false 
        } : undefined
      },
      pool: {
        min: parseInt(process.env.DB_POOL_MIN || '2'),
        max: parseInt(process.env.DB_POOL_MAX || '10'),
        acquireTimeoutMillis: 30000,
        idleTimeoutMillis: 30000
      },
      migrations: {
        tableName: 'knex_migrations',
        directory: './migrations',
        extension: 'ts'
      },
      seeds: {
        directory: './seeds'
      }
    };
  }

  static async connect(): Promise<Knex> {
    if (!Database.instance) {
      await retry(
        async () => {
          Database.instance = knex(Database.config);
          await Database.instance.raw('SELECT 1');
          logger.info('Database connected successfully');
        },
        5,
        5000,
        'Database connection'
      );
    }
    return Database.instance;
  }

  static async redis(): Promise<ReturnType<typeof createClient>> {
    if (!Database.redisClient) {
      Database.redisClient = createClient({
        url: process.env.REDIS_URL,
        socket: {
          reconnectStrategy: (attempts) => Math.min(attempts * 100, 10000)
        }
      });

      Database.redisClient.on('error', (err) => 
        logger.error('Redis error:', err)
      );

      await retry(
        async () => {
          await Database.redisClient.connect();
          logger.info('Redis connected successfully');
        },
        5,
        5000,
        'Redis connection'
      );
    }
    return Database.redisClient;
  }

  static async healthCheck(): Promise<boolean> {
    try {
      await Database.instance.raw('SELECT 1');
      await Database.redisClient.ping();
      return true;
    } catch (error) {
      logger.error('Database health check failed:', error);
      return false;
    }
  }

  static async migrate(): Promise<void> {
    const db = await Database.connect();
    await db.migrate.latest();
    logger.info('Database migrations completed');
  }

  static async seed(): Promise<void> {
    const db = await Database.connect();
    await db.seed.run();
    logger.info('Database seeding completed');
  }

  static async transaction<T>(
    callback: (trx: Knex.Transaction) => Promise<T>
  ): Promise<T> {
    const db = await Database.connect();
    return db.transaction(callback);
  }

  static async close(): Promise<void> {
    if (Database.instance) {
      await Database.instance.destroy();
      logger.info('Database connection closed');
    }
    if (Database.redisClient) {
      await Database.redisClient.quit();
      logger.info('Redis connection closed');
    }
  }
}

// Tipos úteis para operações do banco
export interface ChatMessage {
  id: string;
  session_id: string;
  user_id: string;
  content: string;
  is_bot: boolean;
  created_at: Date;
  updated_at: Date;
}

export interface UserSession {
  id: string;
  user_id: string;
  ip_address: string;
  user_agent: string;
  expires_at: Date;
  created_at: Date;
}