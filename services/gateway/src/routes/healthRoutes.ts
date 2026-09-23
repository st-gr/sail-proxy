/**
 * `GET /health` — the unauthenticated container/readiness probe.
 *
 * Lives in its own module rather than inline in index.ts so it can be mounted on
 * a bare express app in tests: importing index.ts starts the real server.
 */
import { Request, Response } from 'express';
import { queryString } from '../utils/queryParam';

/**
 * `response_wait` (seconds, 1..660) simulates a slow probe, and only when
 * DEBUG=true — it exists to exercise client timeouts.
 *
 * The value is read through queryString, not coerced: express 4.22 parses a
 * bracketed parameter (`?response_wait[a]=1`) into a null-prototype object, and
 * `parseInt(obj as string)` throws `TypeError: Cannot convert object to
 * primitive value`. In this async handler express 4 does not route the
 * rejection to the error handler, so the probe would hang and Node would report
 * an unhandledRejection.
 */
export function createHealthHandler(deployTarget: string) {
  return async (req: Request, res: Response): Promise<void> => {
    const rawResponseWait = queryString(req.query.response_wait);
    const responseWait = rawResponseWait === null ? NaN : parseInt(rawResponseWait, 10);
    const waitTime = (responseWait > 0 && responseWait <= 660) ? responseWait : 0;

    // Only execute simulated timeout when process.env.DEBUG === 'true'
    if (waitTime > 0 && process.env.DEBUG === 'true') {
      await new Promise(resolve => setTimeout(resolve, waitTime * 1000));
    }

    res.json({
      status: 'healthy',
      service: 'gateway',
      deployTarget,
      timestamp: new Date().toISOString(),
      message: 'Gateway service is running with all API routes restored',
      simulatedDelay: waitTime > 0 ? waitTime : undefined
    });
  };
}
