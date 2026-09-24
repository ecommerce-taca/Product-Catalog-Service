import { createParamDecorator, ExecutionContext } from '@nestjs/common';
import { ActorContext } from '../context/actor-context.interface';

export const Actor = createParamDecorator(
  (_data: unknown, ctx: ExecutionContext): ActorContext | undefined => {
    const request = ctx.switchToHttp().getRequest();
    return request.actor;
  },
);
