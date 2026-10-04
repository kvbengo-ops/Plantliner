import { respond, createEnquiry } from './_lib/handlers.js';

export const POST = (request: Request) => respond(request, createEnquiry);
