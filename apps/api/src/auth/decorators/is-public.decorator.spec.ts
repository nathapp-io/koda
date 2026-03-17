import { IsPublic } from './is-public.decorator';
import { Reflector } from '@nestjs/core';

describe('IsPublic decorator', () => {
  it('should set isPublic metadata to true', () => {
    class TestController {
      @IsPublic()
      testMethod() {}
    }

    const reflector = new Reflector();
    const isPublic = reflector.get<boolean>('isPublic', TestController.prototype.testMethod);

    expect(isPublic).toBe(true);
  });

  it('should work as a method decorator', () => {
    class TestController {
      @IsPublic()
      publicRoute() {
        return 'public';
      }
    }

    const reflector = new Reflector();
    const isPublic = reflector.get<boolean>('isPublic', TestController.prototype.publicRoute);

    expect(isPublic).toBe(true);
  });

  it('should allow multiple methods to be marked as public', () => {
    class TestController {
      @IsPublic()
      method1() {}

      @IsPublic()
      method2() {}

      method3() {}
    }

    const reflector = new Reflector();
    const isPublic1 = reflector.get<boolean>('isPublic', TestController.prototype.method1);
    const isPublic2 = reflector.get<boolean>('isPublic', TestController.prototype.method2);
    const isPublic3 = reflector.get<boolean>('isPublic', TestController.prototype.method3);

    expect(isPublic1).toBe(true);
    expect(isPublic2).toBe(true);
    expect(isPublic3).toBeUndefined();
  });
});
