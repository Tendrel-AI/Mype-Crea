import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  context: vi.fn<() => Promise<any>>(),
  listLabReports: vi.fn<() => Promise<any[]>>(),
  getProduct: vi.fn<() => Promise<any>>(),
}));
vi.mock('../../repos', () => ({
  repos: () => ({
    conversations: { context: mocks.context },
    brandFiles: { listLabReports: mocks.listLabReports },
    products: { get: mocks.getProduct },
  }),
}));

import { servingFromPresentation } from '../lab-report-refs';
import { labelTaskInputs } from '../lab-task-inputs';

const CONVERSATION = '3f1c2a4e-9b7d-4c2e-8f10-0a1b2c3d4e5f' as never;
const inputs = labelTaskInputs({ id: 't' as never }, { id: 'u' as never });
const REPORT = { fileId: 'f', storageKey: 'k', sha256: 's', originalName: 'a.pdf' };

describe('servingFromPresentation (KAN-90 principal presentation)', () => {
  it.each([
    ['Botella 500 ml', { amount: 500, unit: 'ml' }],
    ['250 g', { amount: 250, unit: 'g' }],
    ['Sachet 12,5 G', { amount: 12.5, unit: 'g' }],
    ['1 kg', null],
    ['Caja x 6', null],
    ['0 ml', null],
    [undefined, null],
  ])('%s -> %j', (label, expected) => expect(servingFromPresentation(label)).toEqual(expected));
});

describe('labelTaskInputs (recorded in requirements_snapshot)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.context.mockResolvedValue({ brandId: 'b', productId: 'p' });
    mocks.listLabReports.mockResolvedValue([REPORT]);
    mocks.getProduct.mockResolvedValue({ attributes: { product_presentations: [{ label: '1 L', principal: false }, { label: '330 ml', principal: true }] } });
  });

  it('adds the product lab reports and the principal presentation as serving for the label-agent', async () => {
    expect(await inputs(CONVERSATION, 'label-agent')).toEqual({ lab_reports: [REPORT], lab_serving: { amount: 330, unit: 'ml' } });
  });

  it('omits the serving when the principal presentation is not ml/g', async () => {
    mocks.getProduct.mockResolvedValue({ attributes: { product_presentations: [{ label: '1 kg', principal: true }] } });
    expect(await inputs(CONVERSATION, 'label-agent')).toEqual({ lab_reports: [REPORT] });
  });

  it('adds nothing for other agents (and reads nothing)', async () => {
    expect(await inputs(CONVERSATION, 'logo-agent')).toEqual({});
    expect(mocks.context).not.toHaveBeenCalled();
  });

  it('adds nothing in a conversation without a product', async () => {
    mocks.context.mockResolvedValue({ brandId: 'b', productId: null });
    expect(await inputs(CONVERSATION, 'label-agent')).toEqual({});
  });
});
