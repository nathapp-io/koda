import { Injectable } from '@nestjs/common';

@Injectable()
export class OutboxFanOutRegistry {
  private handlers: Map<string, Array<(payload: unknown) => void>> = new Map();

  register(eventType: string, handler: (payload: unknown) => void): void {
    const existing = this.handlers.get(eventType) || [];
    existing.push(handler);
    this.handlers.set(eventType, existing);
  }

  async dispatch(input: { eventType: string; payload: unknown }): Promise<void> {
    const handlers = this.handlers.get(input.eventType) || [];
    for (const handler of handlers) {
      try {
        await Promise.resolve(handler(input.payload));
      } catch (error) {
        console.error(`Handler for ${input.eventType} failed:`, error);
      }
    }
  }

  getHandlers(eventType: string): Array<(payload: unknown) => void> {
    return this.handlers.get(eventType) || [];
  }
}