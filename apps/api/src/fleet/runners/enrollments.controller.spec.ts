import { EnrollmentsController } from './enrollments.controller';
import type { EnrollmentService } from './enrollment.service';
import type { ApprovalRouteGate } from '../../approvals/route/approval-route-gate';

describe('EnrollmentsController', () => {
  it('AC-8: routes create through the enrollment redeem gate', async () => {
    const routeGate = { run: vi.fn().mockResolvedValue({ status: 'executed', result: { id: 'e1' } }) };
    const enrollments = {} as EnrollmentService;
    const controller = new EnrollmentsController(enrollments, routeGate as unknown as ApprovalRouteGate);

    await controller.create({ labels: ['gpu'] }, 'r1');

    expect(routeGate.run).toHaveBeenCalledExactlyOnceWith({
      key: 'fleet.enrollment.create',
      variant: 'rest:fleet-enrollments.create',
      projectId: null,
      input: { labels: ['gpu'] },
      redeem: 'r1',
    });
  });
});
