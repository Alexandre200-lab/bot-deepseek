import { Registry, collectDefaultMetrics, Counter, Histogram, Gauge } from 'prom-client';

// Cria um registro personalizado
const register = new Registry();

// Configura métricas padrão do Node.js
collectDefaultMetrics({
  register,
  prefix: 'node_',
  gcDurationBuckets: [0.1, 1, 5, 15, 30, 60],
  eventLoopMonitoringPrecision: 3
});

// Métricas personalizadas
export const metrics = {
  // Tempo de resposta das requisições HTTP
  httpRequestDuration: new Histogram({
    name: 'http_request_duration_seconds',
    help: 'Duração das requisições HTTP em segundos',
    labelNames: ['method', 'route', 'status'],
    buckets: [0.1, 0.5, 1, 2.5, 5, 10],
    registers: [register]
  }),

  // Contagem total de requisições
  httpRequestsTotal: new Counter({
    name: 'http_requests_total',
    help: 'Contagem total de requisições HTTP',
    labelNames: ['method', 'route', 'status'],
    registers: [register]
  }),

  // Erros na aplicação
  errorsTotal: new Counter({
    name: 'errors_total',
    help: 'Contagem total de erros por tipo',
    labelNames: ['type'],
    registers: [register]
  }),

  // Métricas de cache
  cacheOperations: new Counter({
    name: 'cache_operations_total',
    help: 'Operações de cache por tipo',
    labelNames: ['operation', 'status'],
    registers: [register]
  }),

  // Feature Flags
  featureFlags: new Counter({
    name: 'feature_flag_checks_total',
    help: 'Verificações de feature flags',
    labelNames: ['flag', 'result'],
    registers: [register]
  }),

  // Tempo de avaliação de feature flags
  featureFlagEvaluationTime: new Histogram({
    name: 'feature_flag_evaluation_duration_seconds',
    help: 'Tempo de avaliação de feature flags',
    labelNames: ['flag'],
    buckets: [0.01, 0.05, 0.1, 0.5, 1],
    registers: [register]
  }),

  // Métricas de banco de dados
  databaseQueryDuration: new Histogram({
    name: 'database_query_duration_seconds',
    help: 'Duração das queries de banco de dados',
    labelNames: ['operation', 'success'],
    buckets: [0.01, 0.05, 0.1, 0.5, 1, 2.5],
    registers: [register]
  }),

  // Uso de memória
  memoryUsage: new Gauge({
    name: 'system_memory_usage',
    help: 'Uso de memória do processo em bytes',
    labelNames: ['type'],
    registers: [register]
  }),

  // Conexões WebSocket
  websocketConnections: new Gauge({
    name: 'websocket_connections_total',
    help: 'Conexões WebSocket ativas',
    registers: [register]
  }),

  // Métricas de autenticação
  authAttempts: new Counter({
    name: 'auth_attempts_total',
    help: 'Tentativas de autenticação',
    labelNames: ['status', 'type'],
    registers: [register]
  }),

  // Métricas de negócio
  ordersProcessed: new Counter({
    name: 'orders_processed_total',
    help: 'Total de pedidos processados',
    labelNames: ['status', 'payment_method'],
    registers: [register]
  }),

  /**
   * Middleware para métricas HTTP
   */
  httpMiddleware() {
    return (req, res, next) => {
      const start = Date.now();
      const path = req.route?.path || req.path;

      res.on('finish', () => {
        const duration = Date.now() - start;
        const labels = {
          method: req.method,
          route: path,
          status: res.statusCode
        };

        metrics.httpRequestDuration.observe(labels, duration / 1000);
        metrics.httpRequestsTotal.inc(labels);
      });

      next();
    };
  },

  /**
   * Coleta todas as métricas no formato do Prometheus
   */
  async collect() {
    return register.metrics();
  },

  /**
   * Registra uso de memória
   */
  recordMemoryUsage() {
    const memory = process.memoryUsage();
    this.memoryUsage.set({ type: 'rss' }, memory.rss);
    this.memoryUsage.set({ type: 'heap_total' }, memory.heapTotal);
    this.memoryUsage.set({ type: 'heap_used' }, memory.heapUsed);
    this.memoryUsage.set({ type: 'external' }, memory.external);
  },

  /**
   * Atualiza métricas de WebSocket
   */
  updateWebsocketConnections(count: number) {
    this.websocketConnections.set(count);
  }
};

// Atualiza métricas de memória a cada 5 segundos
setInterval(() => metrics.recordMemoryUsage(), 5000);

// Exporta o registro para uso no endpoint /metrics
export default register;

/* Exemplo de uso:
app.use(metrics.httpMiddleware());

router.post('/login', (req, res) => {
  try {
    // Lógica de login
    metrics.authAttempts.inc({ status: 'success', type: 'login' });
  } catch (error) {
    metrics.authAttempts.inc({ status: 'error', type: 'login' });
    metrics.errorsTotal.inc({ type: 'authentication' });
  }
});
*/