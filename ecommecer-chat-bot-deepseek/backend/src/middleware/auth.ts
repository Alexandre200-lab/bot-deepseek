import { Request, Response, NextFunction } from 'express';
import { Socket } from 'socket.io';
import jwt from 'jsonwebtoken';
import bcrypt from 'bcryptjs';
import { createClient } from 'redis';
import { RateLimiterRedis } from 'rate-limiter-flexible';
import { Database } from './database';
import { logger } from './logger';
import { metrics } from './metrics';
import { User, UserSession, TokenPayload } from '../types/auth';

// Configurações
const JWT_SECRET = process.env.JWT_SECRET!;
const TOKEN_EXPIRY = process.env.TOKEN_EXPIRY || '1h';
const SALT_ROUNDS = 12;
const MAX_LOGIN_ATTEMPTS = 5;
const LOGIN_WINDOW_MINUTES = 15;

// Cliente Redis para rate limiting
const redisClient = createClient({ url: process.env.REDIS_URL });
const rateLimiter = new RateLimiterRedis({
  storeClient: redisClient,
  keyPrefix: 'auth',
  points: MAX_LOGIN_ATTEMPTS,
  duration: LOGIN_WINDOW_MINUTES * 60,
  blockDuration: 30 * 60 // Bloqueia por 30 minutos após exceder
});

export class AuthService {
  // Geração de tokens
  static generateToken(user: User): string {
    const payload: TokenPayload = {
      sub: user.id,
      role: user.role,
      email: user.email
    };

    return jwt.sign(payload, JWT_SECRET, {
      expiresIn: TOKEN_EXPIRY,
      algorithm: 'HS512'
    });
  }

  // Verificação de tokens
  static async verifyToken(token: string): Promise<TokenPayload> {
    try {
      const decoded = jwt.verify(token, JWT_SECRET, {
        algorithms: ['HS512']
      }) as TokenPayload;

      // Verificar se o token está na blacklist
      const isBlacklisted = await redisClient.get(`blacklist:${token}`);
      if (isBlacklisted) {
        throw new Error('Token invalidado');
      }

      return decoded;
    } catch (error) {
      logger.error('Token verification failed:', error);
      throw new Error('Token inválido ou expirado');
    }
  }

  // Middleware para Express
  static authenticate = async (
    req: Request,
    res: Response,
    next: NextFunction
  ) => {
    try {
      const token = this.extractToken(req);
      const payload = await AuthService.verifyToken(token);
      
      const user = await Database.instance<User>('users')
        .where('id', payload.sub)
        .first();

      if (!user) {
        throw new Error('Usuário não encontrado');
      }

      req.user = user;
      metrics.incrementAuthSuccess();
      next();
    } catch (error) {
      metrics.incrementAuthFailure();
      res.status(401).json({ error: error.message });
    }
  };

  // Middleware para Socket.IO
  static authenticateSocket = async (socket: Socket, next: (err?: Error) => void) => {
    try {
      const token = this.extractSocketToken(socket);
      const payload = await AuthService.verifyToken(token);
      
      const user = await Database.instance<User>('users')
        .where('id', payload.sub)
        .first();

      if (!user) {
        throw new Error('Usuário não encontrado');
      }

      socket.data.user = user;
      next();
    } catch (error) {
      logger.warn(`Socket auth failed: ${error.message}`);
      next(new Error('Autenticação falhou'));
    }
  };

  // Login de usuário com rate limiting
  static async login(email: string, password: string): Promise<string> {
    const rlKey = `login:${email}`;
    
    try {
      await rateLimiter.consume(rlKey);

      const user = await Database.instance<User>('users')
        .where('email', email)
        .first();

      if (!user || !(await bcrypt.compare(password, user.password))) {
        throw new Error('Credenciais inválidas');
      }

      if (user.status !== 'active') {
        throw new Error('Conta desativada');
      }

      await this.recordLoginSuccess(user.id);
      return this.generateToken(user);
    } catch (error) {
      await this.recordLoginFailure(email, error.message);
      throw error;
    }
  }

  // Logout e invalidação de token
  static async logout(token: string): Promise<void> {
    const decoded = jwt.decode(token) as TokenPayload;
    const expiry = decoded.exp - Math.floor(Date.now() / 1000);
    
    await redisClient.set(`blacklist:${token}`, '1', {
      EX: expiry
    });
  }

  // Controle de acesso baseado em roles
  static requireRole(...roles: string[]) {
    return (req: Request, res: Response, next: NextFunction) => {
      if (!roles.includes(req.user.role)) {
        metrics.incrementAuthForbidden();
        return res.status(403).json({ error: 'Acesso não autorizado' });
      }
      next();
    };
  }

  // Métodos auxiliares privados
  private static extractToken(req: Request): string {
    const authHeader = req.headers.authorization;
    if (!authHeader?.startsWith('Bearer ')) {
      throw new Error('Formato de token inválido');
    }
    return authHeader.split(' ')[1];
  }

  private static extractSocketToken(socket: Socket): string {
    return socket.handshake.auth.token || 
      socket.handshake.headers.authorization?.split(' ')[1];
  }

  private static async recordLoginSuccess(userId: string): Promise<void> {
    await Database.instance<User>('users')
      .where('id', userId)
      .update({
        last_login: Database.instance.fn.now(),
        login_attempts: 0
      });
  }

  private static async recordLoginFailure(email: string, reason: string): Promise<void> {
    logger.warn(`Login failed for ${email}: ${reason}`);
    
    try {
      await Database.instance<User>('users')
        .where('email', email)
        .increment('login_attempts', 1);
    } catch (error) {
      logger.error('Failed to record login attempt:', error);
    }
  }
}

// Tipos auxiliares (types/auth.ts)
declare global {
  namespace Express {
    interface Request {
      user?: User;
    }
  }
}

export interface User {
  id: string;
  email: string;
  password: string;
  role: 'user' | 'admin' | 'support';
  status: 'active' | 'suspended' | 'pending';
  login_attempts: number;
  last_login?: Date;
  created_at: Date;
  updated_at: Date;
}

export interface TokenPayload {
  sub: string;
  role: string;
  email: string;
  iat?: number;
  exp?: number;
}

export class AuthError extends Error {
  constructor(message: string, public readonly code: string) {
    super(message);
    this.name = 'AuthError';
  }
}