import { respond, getVisualization } from '../_lib/handlers.js';

export const GET = (request: Request) =>
  respond(request, async () => {
    const id = new URL(request.url).pathname.split('/').pop() ?? '';
    return /^[A-Za-z0-9]{20}$/.test(id) ? getVisualization(id) : [404, { error: 'Not found' }];
  });
