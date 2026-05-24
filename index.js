require("dotenv").config();
const express = require("express");
const morgan = require("morgan");
const promClient = require("prom-client");
const winston = require("winston");
const LokiTransport = require("winston-loki");

const loggerTransports = [
  new winston.transports.Console({
    format: winston.format.combine(
      winston.format.colorize(), // Add colors for better readability in the console
      winston.format.simple(), // Simplified format for console output
    ),
  }),
  new winston.transports.File({
    filename: "error.log",
    level: "error", // Log only errors to this file
  }),
  new winston.transports.File({
    filename: "combined.log", // Log all levels to combined log file
  }),
];

if (process.env.LOKI_HOST) {
  loggerTransports.push(
    new LokiTransport({
      host: process.env.LOKI_HOST,
      labels: {
        app: process.env.LOKI_APP_LABEL || "project-log-pg",
        env: process.env.NODE_ENV || "development",
      },
      json: true,
      format: winston.format.json(),
      replaceTimestamp: true,
    }),
  );
}

// Create logger for production
const logger = winston.createLogger({
  level: process.env.LOG_LEVEL || "info", // Default log level
  format: winston.format.combine(
    winston.format.timestamp(),
    winston.format.json(), // Use JSON format for production logs
  ),
  transports: loggerTransports,
});

const app = express();
const PORT = process.env.PORT || 3001;
const register = new promClient.Registry();

app.use(
  morgan(
    process.env.NODE_ENV === "production"
      ? ":method :url :status :response-time ms" // Simplified format for production
      : ":method :url :status :response-time ms - :res[content-length]", // More detailed for dev
    {
      stream: {
        write: (message) => logger.info(message.trim()), // Pass morgan logs to winston
      },
    },
  ),
);

promClient.collectDefaultMetrics({ register });

const httpRequestsTotal = new promClient.Counter({
  name: "http_requests_total",
  help: "Total number of HTTP requests",
  labelNames: ["method", "route", "status_code"],
  registers: [register],
});

const httpRequestsInFlight = new promClient.Gauge({
  name: "http_requests_in_flight",
  help: "Current number of in-flight HTTP requests",
  labelNames: ["method", "route"],
  registers: [register],
});

const httpRequestDurationSeconds = new promClient.Histogram({
  name: "http_request_duration_seconds",
  help: "HTTP request duration in seconds",
  labelNames: ["method", "route", "status_code"],
  buckets: [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2, 5],
  registers: [register],
});

const httpRequestDurationSummary = new promClient.Summary({
  name: "http_request_duration_summary_seconds",
  help: "HTTP request duration summary in seconds",
  labelNames: ["method", "route", "status_code"],
  percentiles: [0.5, 0.9, 0.95, 0.99],
  registers: [register],
});

app.use((req, res, next) => {
  const labels = { method: req.method, route: req.path };
  const stopHistogramTimer = httpRequestDurationSeconds.startTimer(labels);
  const stopSummaryTimer = httpRequestDurationSummary.startTimer(labels);
  httpRequestsInFlight.inc(labels);

  let recorded = false;
  const recordMetrics = () => {
    if (recorded) return;
    recorded = true;

    const statusCode = String(res.statusCode);
    httpRequestsTotal.inc({ ...labels, status_code: statusCode });
    httpRequestsInFlight.dec(labels);
    stopHistogramTimer({ status_code: statusCode });
    stopSummaryTimer({ status_code: statusCode });
  };

  res.once("finish", recordMetrics);
  res.once("close", recordMetrics);
  next();
});

app.get("/", (req, res) => {
  logger.info("GET / requested");
  res.status(200).json({
    status: "ok",
    project: "project-1-freestyles",
    message: "Welcome to Project 1 API",
  });
});

app.get("/health", (req, res) => {
  logger.info("GET /health requested");
  res.status(200).json({
    status: "ok",
    project: "project-1-freestyle",
    message: "Service is healthy",
  });
});

app.get("/metrics", async (req, res) => {
  logger.info("GET /metrics requested");
  try {
    res.set("Content-Type", register.contentType);
    res.end(await register.metrics());
  } catch (error) {
    logger.error(`Failed to generate metrics: ${error.message}`);
    res.status(500).json({ error: "Failed to generate metrics" });
  }
});

if (require.main === module) {
  app.listen(PORT, () => {
    logger.info(`Project 1 API running on port ${PORT}`);
  });
}

module.exports = app;
