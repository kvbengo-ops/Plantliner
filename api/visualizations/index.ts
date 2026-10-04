import { respond, createVisualization } from '../_lib/handlers.js';

export const POST = (request: Request) => respond(request, createVisualization);
