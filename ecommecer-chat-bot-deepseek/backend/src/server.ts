import 'dotenv/config';
import express from 'express';
import http from 'http';
import { Server } from 'socket.io';
import { createClient } from 'redis';
import helmet from 'helmet';
import cors from 'cors';
import { AIService } from './services/AIService';
import { FeatureFlagService } from './services/FeatureFlagService';
import { logger } from './utils/logger';
import { metricsMiddleware, register } from './utils/metrics';
import { trace } from '@opentelemetry/api';

// Configuração inicial
const app = express();
const server = http.createServer(app);
const port = process.env.PORT || 3001;

// Middlewares básicos
app.use(helmet());
app.use(cors({
  origin: process.env.CORS_ORIGIN?.split(',') || '*',
  methods: ['GET', 'POST']
}));
app.use(express.json());
app.use(metricsMiddleware);

// Inicialização do Redis
const redisClient = createClient({
  url: process.env.REDIS_URL,
  socket: {
    reconnectStrategy: (attempts) => Math.min(attempts * 100, 5000)
  }
});

redisClient.on('error', (err) => logger.error('Redis error:', err));
redisClient.on('connect', () => logger.info('Connected to Redis'));
await redisClient.connect();

// Configuração do WebSocket
const io = new Server(server, {
  cors: {
    origin: process.env.WS_CORS_ORIGIN?.split(',') || '*',
    methods: ['GET', 'POST']
  },
  connectionStateRecovery: {
    maxDisconnectionDuration: 2 * 60 * 1000,
    skipMiddlewares: true
  }
});

// Serviços principais
const aiService = new AIService();
const featureFlags = new FeatureFlagService();

// Middleware de autenticação WebSocket
io.use(async (socket, next) => {
  try {
    const token = socket.handshake.auth.token;
    if (!token) throw new Error('Authentication required');
    
    // Validação do token JWT
    const user = await verifyToken(token);
    socket.data.user = user;
    next();
  } catch (error) {
    next(new Error('Authentication failed'));
  }
});

// Tratamento de conexões WebSocket
io.on('connection', (socket) => {
  logger.info(`Client connected: ${socket.id}`);
  const tracer = trace.getTracer('chat-tracer');
  
  // Evento principal de mensagem
  socket.on('message', async (message, callback) => {
    const span = tracer.startSpan('process_message');
    
    try {
      // 1. Verificar cache
      const cachedResponse = await redisClient.get(message.text);
      if (cachedResponse) {
        span.setAttribute('cache.hit', true);
        return callback({ 
          text: cachedResponse, 
          isBot: true,
          cached: true 
        });
      }

      // 2. Feature flags
      const useExperimental = await featureFlags.checkFlag(
        'experimental-model',
        socket.data.user.id
      );

      // 3. Gerar resposta
      const start = Date.now();
      const response = useExperimental
        ? await aiService.generateExperimental(message.text)
        : await aiService.generate(message.text);
      
      // 4. Armazenar cache
      await redisClient.setEx(message.text, 3600, response);

      // 5. Métricas
      const latency = Date.now() - start;
      register.getSingleMetric('response_latency').observe(latency);
      register.getSingleMetric('messages_total').inc();

      callback({
        text: response,
        isBot: true,
        model: useExperimental ? 'experimental' : 'stable'
      });

      span.setStatus({ code: trace.StatusCode.OK });
    } catch (error) {
      logger.error('Message processing error:', error);
      span.setStatus({ 
        code: trace.StatusCode.ERROR,
        message: error.message 
      });
      callback({ error: 'Failed to process message' });
    } finally {
      span.end();
    }
  });

  // Tratamento de desconexão
  socket.on('disconnect', (reason) => {
    logger.info(`Client disconnected: ${socket.id} - ${reason}`);
  });

  // Tratamento de erros
  socket.on('error', (error) => {
    logger.error('Socket error:', error);
  });
});

// Health checks
app.get('/health', (req, res) => {
  res.status(200).json({
    status: 'OK',
    uptime: process.uptime(),
    timestamp: new Date().toISOString()
  });
});

// Métricas Prometheus
app.get('/metrics', async (req, res) => {
  try {
    res.set('Content-Type', register.contentType);
    res.end(await register.metrics());
  } catch (error) {
    res.status(500).end();
  }
});

// Inicialização do servidor
server.listen(port, () => {
  logger.info(`
   Server running on port ${port}
   Metrics: http://localhost:${port}/metrics
   WebSocket: ws://localhost:${port}
  `);
});

// Graceful shutdown
process.on('SIGTERM', async () => {
  logger.info('Shutting down server...');
  
  await redisClient.quit();
  io.close(() => server.close());
});