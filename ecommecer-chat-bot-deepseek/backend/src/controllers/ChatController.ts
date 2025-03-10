import { WebSocketGateway, WebSocketServer, SubscribeMessage, MessageBody, ConnectedSocket } from '@nestjs/websockets';
import { Server, Socket } from 'socket.io';
import { createClient } from 'redis';
import { AIService } from '../services/AIService';
import { FeatureFlagService } from '../services/FeatureFlagService';
import { CacheService } from '../services/CacheService';
import { logger } from '../utils/logger';
import { metrics } from '../utils/metrics';
import { trace } from '@opentelemetry/api';
import { verifyToken } from '../middleware/auth';
import { Database } from '../config/database';
import { ChatMessage, UserSession } from '../types/database';

@WebSocketGateway({
  cors: {
    origin: process.env.WS_CORS_ORIGIN?.split(',') || '*',
    methods: ['GET', 'POST']
  },
  connectionStateRecovery: {
    maxDisconnectionDuration: 120000 // 2 minutos
  }
})
export class ChatController {
  @WebSocketServer()
  server: Server;

  private redisPublisher = createClient({ url: process.env.REDIS_URL });
  private redisSubscriber = createClient({ url: process.env.REDIS_URL });

  constructor(
    private readonly aiService: AIService,
    private readonly featureFlags: FeatureFlagService,
    private readonly cacheService: CacheService
  ) {
    this.setupRedisPubSub();
  }

  // Configuração inicial do Redis Pub/Sub
  private async setupRedisPubSub() {
    await this.redisPublisher.connect();
    await this.redisSubscriber.connect();
    
    this.redisSubscriber.subscribe('chat-events', (message) => {
      this.server.emit('system-message', JSON.parse(message));
    });
  }

  // Middleware de autenticação
  async handleConnection(@ConnectedSocket() socket: Socket) {
    try {
      const token = socket.handshake.auth.token;
      const user = await verifyToken(token);
      
      socket.data.user = user;
      await this.createUserSession(socket);
      
      logger.info(`User connected: ${user.id}`);
      this.sendSystemMessage(`${user.email} entrou no chat`);
      
    } catch (error) {
      logger.warn(`Connection rejected: ${error.message}`);
      socket.disconnect(true);
    }
  }

  // Principal handler de mensagens
  @SubscribeMessage('message')
  async handleMessage(
    @MessageBody() content: string,
    @ConnectedSocket() socket: Socket
  ) {
    const tracer = trace.getTracer('chat-tracer');
    const span = tracer.startSpan('process-message');
    
    try {
      span.setAttributes({
        'user.id': socket.data.user.id,
        'message.length': content.length
      });

      // 1. Validação da mensagem
      if (!this.validateMessage(content)) {
        throw new Error('Mensagem inválida');
      }

      // 2. Armazenar mensagem do usuário
      const userMessage = await this.storeMessage(socket, content, false);
      this.server.emit('message', userMessage);

      // 3. Processamento da IA
      const startTime = Date.now();
      const aiResponse = await this.processWithAI(socket, content);
      
      // 4. Armazenar resposta
      const botMessage = await this.storeMessage(socket, aiResponse, true);
      this.server.emit('message', botMessage);

      // 5. Métricas
      const latency = Date.now() - startTime;
      metrics.recordLatency(latency);
      metrics.incrementMessages();

      span.setStatus({ code: trace.StatusCode.OK });

    } catch (error) {
      logger.error(`Message error: ${error.message}`, {
        userId: socket.data.user.id,
        content
      });
      
      span.setStatus({
        code: trace.StatusCode.ERROR,
        message: error.message
      });
      
      socket.emit('error', {
        type: 'processing-error',
        message: 'Erro ao processar mensagem'
      });
      
    } finally {
      span.end();
    }
  }

  // Métodos auxiliares
  private async processWithAI(socket: Socket, content: string): Promise<string> {
    // 1. Verificar cache
    const cachedResponse = await this.cacheService.get(content);
    if (cachedResponse) {
      metrics.incrementCacheHits();
      return cachedResponse;
    }

    // 2. Feature flags
    const useExperimental = await this.featureFlags.checkFlag(
      'experimental-model',
      socket.data.user.id
    );

    // 3. Gerar resposta
    const response = useExperimental
      ? await this.aiService.generateExperimental(content)
      : await this.aiService.generate(content);

    // 4. Armazenar em cache
    await this.cacheService.set(content, response, 3600); // 1 hora

    return response;
  }

  private async storeMessage(
    socket: Socket,
    content: string,
    isBot: boolean
  ): Promise<ChatMessage> {
    return Database.transaction(async (trx) => {
      const [message] = await trx<ChatMessage>('messages').insert({
        session_id: socket.data.sessionId,
        user_id: socket.data.user.id,
        content,
        is_bot: isBot,
        intent: isBot ? null : await this.detectIntent(content)
      }).returning('*');
      
      return message;
    });
  }

  private async createUserSession(socket: Socket): Promise<void> {
    const sessionData = {
      user_id: socket.data.user.id,
      ip_address: socket.handshake.address,
      user_agent: socket.handshake.headers['user-agent'],
      expires_at: Database.instance.raw("NOW() + INTERVAL '1 HOUR'")
    };

    const [session] = await Database.instance<UserSession>('sessions')
      .insert(sessionData)
      .returning('id');

    socket.data.sessionId = session.id;
  }

  private async detectIntent(content: string): Promise<string> {
    // Implementar lógica de detecção de intenção
    return 'general';
  }

  private validateMessage(content: string): boolean {
    return content.length > 0 && content.length <= 500;
  }

  private sendSystemMessage(message: string): void {
    this.redisPublisher.publish('chat-events', JSON.stringify({
      type: 'system',
      content: message,
      timestamp: new Date()
    }));
  }

  // Eventos de desconexão
  handleDisconnect(socket: Socket) {
    logger.info(`User disconnected: ${socket.data.user.id}`);
    this.sendSystemMessage(`${socket.data.user.email} saiu do chat`);
    Database.instance('sessions')
      .where('id', socket.data.sessionId)
      .update({ expires_at: Database.instance.fn.now() });
  }
}