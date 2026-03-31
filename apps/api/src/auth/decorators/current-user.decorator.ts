import { createParamDecorator, ExecutionContext } from '@nestjs/common';

export const CurrentUser = createParamDecorator((data: unknown, ctx: ExecutionContext) => {
  const request = ctx.switchToHttp().getRequest();
  // Return request.user for JWT auth, or request.agent for API key auth
  return request.user || request.agent;
});

export const CurrentActor = createParamDecorator(
  (data: unknown, ctx: ExecutionContext) => {
    const request = ctx.switchToHttp().getRequest();
    const actorType = request.actorType ?? (request.user ? 'user' : undefined);
    return {
      currentUser: request.user || request.agent,
      actorType,
    };
  },
);
