import { Request, Response, NextFunction } from 'express';
import helmet from 'helmet';
import cors from 'cors';
import csrf from 'csurf';
import rateLimit from 'express-rate-limit';
import mongoSanitize from 'express-mongo-sanitize';
import hpp from 'hpp';
import xss from 'xss-clean';
import { createClient } from 'redis';
import { RateLimiterRedis } from 'rate-limiter-flexible';
import { logger } from './logger';
import { metrics } from './metrics';
import { Database } from './database';

// Configurações de segurança
const ENVIRONMENT = process.env.NODE_ENV || 'development';
const TRUSTED_DOMAINS = process.env.TRUSTED_DOMAINS?.split(',') || [];
const API_RATE_LIMIT = parseInt(process.env.API_RATE_LIMIT || '100');
const SECURITY_HEADERS = {
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      scriptSrc: ["'self'", "'unsafe-inline'", "trusted.cdn.com"],
      styleSrc: ["'self'", "'unsafe-inline'"],
      imgSrc: ["'self'", "data:", "cdn.example.com"],
      connectSrc: ["'self'", "api.example.com"],
      fontSrc: ["'self'", "fonts.gstatic.com"],
      objectSrc: ["'none'"],
      upgradeInsecureRequests: ENVIRONMENT === 'production' ? [] : null
    }
  },
  frameguard: { action: 'deny' },
  hidePoweredBy: true,
  hsts: {
    maxAge: 63072000,
    includeSubDomains: true,
    preload: true
  }
};

// Cliente Redis para rate limiting distribuído
const redisClient = createClient({ url: process.env.REDIS_URL });
const rateLimiter = new RateLimiterRedis({
  storeClient: redisClient,
  keyPrefix: 'security',
  points: API_RATE_LIMIT,
  duration: 15 * 60, // 15 minutos
  blockDuration: 30 * 60 // Bloqueia por 30 minutos
});

export class SecurityMiddleware {
  // Configuração completa de headers de segurança
  static headers() {
    return helmet(SECURITY_HEADERS);
  }

  // Política CORS estrita
  static cors() {
    return cors({
      origin: (origin, callback) => {
        if (!origin || TRUSTED_DOMAINS.includes(origin)) {
          callback(null, true);
        } else {
          metrics.incrementCorsViolation();
          callback(new Error('Acesso CORS não permitido'));
        }
      },
      methods: ['GET', 'POST', 'PUT', 'DELETE'],
      allowedHeaders: ['Content-Type', 'Authorization'],
      credentials: true,
      maxAge: 86400
    });
  }

  // Prevenção de ataques comuns
  static sanitization() {
    return [
      mongoSanitize(), // Prevenção de NoSQL injection
      xss(), // Prevenção de XSS
      hpp(), // Prevenção de parameter pollution
      express.json({ limit: '10kb' }) // Limite de payload
    ];
  }

  // Rate limiting distribuído
  static apiLimiter() {
    return async (req: Request, res: Response, next: NextFunction) => {
      try {
        const key = req.ip;
        await rateLimiter.consume(key);
        next();
      } catch (error) {
        metrics.incrementRateLimitHit();
        res.status(429).json({
          error: 'Muitas requisições. Tente novamente mais tarde.'
        });
      }
    };
  }

  // Proteção CSRF para formulários
  static csrfProtection() {
    return csrf({
      cookie: {
        httpOnly: true,
        secure: ENVIRONMENT === 'production',
        sameSite: 'strict',
        maxAge: 86400
      },
      value: (req) => req.headers['x-csrf-token']
    });
  }

  // Validação de conteúdo seguro
  static contentValidation() {
    return (req: Request, res: Response, next: NextFunction) => {
      // Validar Content-Type para APIs
      if (req.path.startsWith('/api') && !req.is('json')) {
        return res.status(415).json({ error: 'Tipo de conteúdo não suportado' });
      }

      // Validar parâmetros de consulta
      const invalidParams = Object.keys(req.query).filter(param => 
        param.startsWith('$') || param.includes(';')
      );
      
      if (invalidParams.length > 0) {
        metrics.incrementInvalidRequest();
        return res.status(400).json({ 
          error: 'Parâmetros de consulta inválidos',
          invalidParams
        });
      }

      next();
    };
  }

  // Segurança para uploads de arquivos
  static fileUploadSecurity() {
    return (req: Request, res: Response, next: NextFunction) => {
      if (req.files) {
        const files = Array.isArray(req.files) ? req.files : Object.values(req.files);
        
        for (const file of files.flat()) {
          // Verificar tipo MIME
          const validTypes = ['image/jpeg', 'image/png', 'application/pdf'];
          if (!validTypes.includes(file.mimetype)) {
            return res.status(400).json({ error: 'Tipo de arquivo não permitido' });
          }

          // Verificar extensão do arquivo
          const validExtensions = ['.jpg', '.jpeg', '.png', '.pdf'];
          const extension = file.name.split('.').pop()?.toLowerCase();
          if (!extension || !validExtensions.includes(`.${extension}`)) {
            return res.status(400).json({ error: 'Extensão de arquivo inválida' });
          }
        }
      }
      next();
    };
  }

  // Middleware de erros de segurança
  static errorHandler() {
    return (err: any, req: Request, res: Response, next: NextFunction) => {
      if (err.code === 'EBADCSRFTOKEN') {
        metrics.incrementCsrfViolation();
        return res.status(403).json({ error: 'Token CSRF inválido' });
      }

      if (err instanceof SyntaxError) {
        metrics.incrementInvalidJson();
        return res.status(400).json({ error: 'JSON inválido' });
      }

      // Log de segurança detalhado
      logger.securityAlert({
        message: 'Violação de segurança detectada',
        ip: req.ip,
        method: req.method,
        url: req.originalUrl,
        userAgent: req.headers['user-agent'],
        error: err.message
      });

      next(err);
    };
  }

  // Auditoria de segurança em tempo real
  static securityAudit() {
    return async (req: Request, res: Response, next: NextFunction) => {
      const auditData = {
        timestamp: new Date(),
        ip: req.ip,
        method: req.method,
        url: req.originalUrl,
        headers: req.headers,
        params: req.params,
        query: req.query,
        body: req.body
      };

      try {
        await Database.instance('security_audit').insert(auditData);
      } catch (error) {
        logger.error('Falha no registro de auditoria:', error);
      }

      next();
    };
  }

  // Middleware de HTTPS obrigatório
  static requireHttps() {
    return (req: Request, res: Response, next: NextFunction) => {
      if (ENVIRONMENT === 'production' && !req.secure) {
        return res.redirect(`https://${req.headers.host}${req.url}`);
      }
      next();
    };
  }
}

// Tipos estendidos para segurança
declare global {
  namespace Express {
    interface Request {
      securityContext?: {
        ip: string;
        riskScore: number;
        isBot: boolean;
      };
    }
  }
}