import { forecast } from './engine.mjs';

self.addEventListener('message', async event => {
  const { requestId, payload, config } = event.data || {};
  try {
    const result = await forecast(payload, config);
    self.postMessage({ requestId, result });
  } catch (error) {
    self.postMessage({ requestId, error: error instanceof Error ? error.message : String(error) });
  }
});
