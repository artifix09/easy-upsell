const ERROR_WEBHOOK_URL = process.env.ERROR_WEBHOOK_URL || '';

export async function reportError({ source, message, details = {} }) {
  if (!ERROR_WEBHOOK_URL) {
    return;
  }

  try {
    await fetch(ERROR_WEBHOOK_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        source,
        message,
        details,
        ts: new Date().toISOString(),
      }),
    });
  } catch {
    // Intentionally swallow errors to avoid cascading failures.
  }
}

export function captureProcessErrors() {
  process.on('unhandledRejection', (reason) => {
    const message = reason instanceof Error ? reason.message : String(reason);
    reportError({ source: 'process', message, details: { type: 'unhandledRejection' } });
  });

  process.on('uncaughtException', (error) => {
    reportError({ source: 'process', message: error.message, details: { type: 'uncaughtException' } });
  });
}
