import { NodeSDK } from '@opentelemetry/sdk-node';
import { getNodeAutoInstrumentations } from '@opentelemetry/auto-instrumentations-node';
import { Resource } from '@opentelemetry/resources';
import { SemanticResourceAttributes } from '@opentelemetry/semantic-conventions';
import { JaegerExporter } from '@opentelemetry/exporter-jaeger';
import { BatchSpanProcessor, ConsoleSpanExporter } from '@opentelemetry/sdk-trace-node';
import { trace, Span, context, propagation, Tracer } from '@opentelemetry/api';
import { ExpressInstrumentation } from '@opentelemetry/instrumentation-express';
import { HttpInstrumentation } from '@opentelemetry/instrumentation-http';
import { PgInstrumentation } from '@opentelemetry/instrumentation-pg';
import { RedisInstrumentation } from '@opentelemetry/instrumentation-redis';
import { SocketIoInstrumentation } from '@opentelemetry/instrumentation-socket.io';
import { diag, DiagConsoleLogger, DiagLogLevel } from '@opentelemetry/api';

// Configuração básica de logging
diag.setLogger(new DiagConsoleLogger(), DiagLogLevel.INFO);

// Configuração do recurso
const resource = new Resource({
  [SemanticResourceAttributes.SERVICE_NAME]: 'ecommerce-chat',
  [SemanticResourceAttributes.SERVICE_NAMESPACE]: process.env.APP_ENV || 'development',
  [SemanticResourceAttributes.DEPLOYMENT_ENVIRONMENT]: process.env.NODE_ENV || 'local'
});

// Configuração do exportador Jaeger
const jaegerExporter = new JaegerExporter({
  endpoint: process.env.JAEGER_ENDPOINT || 'http://localhost:14268/api/traces',
});

// Processador de spans
const spanProcessor = new BatchSpanProcessor(jaegerExporter);

// Configuração do SDK
const sdk = new NodeSDK({
  resource,
  spanProcessor,
  instrumentations: [
    new HttpInstrumentation(),
    new ExpressInstrumentation(),
    new PgInstrumentation(),
    new RedisInstrumentation(),
    new SocketIoInstrumentation(),
    getNodeAutoInstrumentations({
      '@opentelemetry/instrumentation-fs': { enabled: false },
    }),
  ],
});

// Inicialização do tracing
sdk.start()
  .then(() => console.log('Tracing initialized'))
  .catch((error) => console.error('Error initializing tracing', error));

// Interface para contexto personalizado
interface CustomSpanContext {
  userId?: string;
  sessionId?: string;
  featureFlags?: string[];
}

// Utilitários de tracing
export const tracing = {
  /**
   * Cria um novo tracer
   */
  getTracer(name: string): Tracer {
    return trace.getTracer(name);
  },

  /**
   * Cria uma nova span com contexto personalizado
   */
  createSpan(name: string, parentContext?: any, customContext?: CustomSpanContext): Span {
    const tracer = trace.getTracer('ecommerce-chat');
    const span = tracer.startSpan(name, {}, parentContext ? propagation.extract(context.active(), parentContext) : undefined);

    if (customContext) {
      span.setAttributes({
        'user.id': customContext.userId,
        'session.id': customContext.sessionId,
        'feature.flags': customContext.featureFlags?.join(','),
      });
    }

    return span;
  },

  /**
   * Middleware para Express com tracing automático
   */
  expressMiddleware() {
    return (req: any, res: any, next: any) => {
      const span = this.createSpan(`HTTP ${req.method} ${req.path}`, req.headers, {
        userId: req.user?.id,
        sessionId: req.session?.id
      });

      span.setAttributes({
        'http.method': req.method,
        'http.path': req.path,
        'http.route': req.route?.path,
        'http.user_agent': req.headers['user-agent'],
        'http.client_ip': req.ip,
      });

      context.with(trace.setSpan(context.active(), span), () => {
        res.on('finish', () => {
          span.setAttribute('http.status_code', res.statusCode);
          span.end();
        });
        next();
      });
    };
  },

  /**
   * Instrumentação para WebSocket
   */
  instrumentWebSocket(socket: any) {
    const span = this.createSpan('WS Connection', socket.handshake.headers, {
      userId: socket.user?.id,
      sessionId: socket.sessionId
    });

    span.setAttributes({
      'ws.event': 'connection',
      'ws.id': socket.id,
      'ws.secure': socket.secure,
    });

    // Instrumentar eventos
    const originalEmit = socket.emit;
    socket.emit = (event: string, ...args: any[]) => {
      const eventSpan = this.createSpan(`WS EMIT ${event}`, null, {
        userId: socket.user?.id
      });
      
      eventSpan.setAttributes({
        'ws.event': event,
        'ws.payload_size': JSON.stringify(args).length,
      });

      try {
        originalEmit.apply(socket, [event, ...args]);
        eventSpan.setStatus({ code: 0 });
      } catch (error) {
        eventSpan.setStatus({ code: 2, message: error.message });
        eventSpan.recordException(error);
      } finally {
        eventSpan.end();
      }
    };

    socket.on('disconnect', (reason: string) => {
      span.setAttribute('ws.disconnect_reason', reason);
      span.end();
    });
  },

  /**
   * Instrumentação para chamadas de IA
   */
  async traceAIRequest<T>(operation: string, fn: (span: Span) => Promise<T>): Promise<T> {
    const span = this.createSpan(`AI ${operation}`);
    
    try {
      const result = await fn(span);
      span.setStatus({ code: 0 });
      return result;
    } catch (error) {
      span.setStatus({ code: 2, message: error.message });
      span.recordException(error);
      throw error;
    } finally {
      span.end();
    }
  },

  /**
   * Cria contexto para propagação distribuída
   */
  createPropagationContext(context: Record<string, string>): Record<string, string> {
    const carrier: Record<string, string> = {};
    propagation.inject(context.active(), carrier);
    return { ...context, ...carrier };
  },

  /**
   * Captura exceptions globais não tratadas
   */
  captureUnhandledExceptions() {
    process.on('uncaughtException', (error) => {
      const span = this.createSpan('Unhandled Exception');
      span.recordException(error);
      span.setStatus({ code: 2, message: 'Unhandled exception' });
      span.end();
    });
  }
};

// Capturar exceptions globais
tracing.captureUnhandledExceptions();

// Exportar o SDK para desligamento adequado
export const otelSDK = sdk;

// Exemplo de uso:
/*
router.get('/products', tracing.expressMiddleware(), (req, res) => {
  // Sua lógica aqui
});

async function aiCall() {
  return tracing.traceAIRequest('generateResponse', async (span) => {
    span.setAttribute('ai.model', 'deepseek-1.3b');
    // Chamada real para a IA
  });
}
*/