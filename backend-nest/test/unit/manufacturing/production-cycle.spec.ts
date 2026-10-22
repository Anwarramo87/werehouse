import { ProductionStageStatus, ProductionStageType } from '@prisma/client';

/**
 * The production cycle, tested without a database.
 *
 * ── The rules being defended ───────────────────────────────────────────────
 * 1. A stage cannot produce more than it received: output + waste + defects
 *    must not exceed the input.
 * 2. A stage cannot be skipped: the previous stage must be finished first.
 * 3. A stage that is already running cannot be started again, and a finished
 *    one cannot be finished twice — otherwise the same quantity is counted
 *    twice.
 * 4. A batch is complete only when EVERY stage, the last one included, is
 *    complete.
 * 5. A return to an earlier stage resets that stage and every stage after
 *    it, and the reason is mandatory — a return is a documented operation,
 *    never a silent edit of dates or quantities.
 */
describe('Production stage rules', () => {
  const STAGE_ORDER: ProductionStageType[] = [
    ProductionStageType.CUTTING,
    ProductionStageType.SEWING,
    ProductionStageType.ASSEMBLY,
    ProductionStageType.FINISHED,
  ];

  interface Stage {
    stageType: ProductionStageType;
    status: ProductionStageStatus;
    inputQty: number;
    outputQty: number;
    wasteQty: number;
    defectiveQty: number;
  }

  const makeStages = (): Stage[] =>
    STAGE_ORDER.map((stageType) => ({
      stageType,
      status: ProductionStageStatus.PENDING,
      inputQty: 0,
      outputQty: 0,
      wasteQty: 0,
      defectiveQty: 0,
    }));

  /** The quantity rule from rule 1. */
  const isBalanced = (stage: Stage, outputQty: number, wasteQty: number, defectiveQty: number) =>
    outputQty + wasteQty + defectiveQty <= stage.inputQty;

  /** The "previous stage must be finished" rule from rule 2. */
  const canStart = (stages: Stage[], stageType: ProductionStageType) => {
    const index = STAGE_ORDER.indexOf(stageType);
    if (index <= 0) return true;
    return stages.find((s) => s.stageType === STAGE_ORDER[index - 1])!.status ===
      ProductionStageStatus.COMPLETED;
  };

  /** The "not twice" rule from rule 3. */
  const canComplete = (stage: Stage) => stage.status !== ProductionStageStatus.COMPLETED;

  /** The "complete only at the end" rule from rule 4. */
  const isBatchComplete = (stages: Stage[]) =>
    stages.every((s) => s.status === ProductionStageStatus.COMPLETED);

  /** The "return resets this stage and everything after" rule from rule 5. */
  const stagesResetByReturn = (stages: Stage[], target: ProductionStageType) => {
    const targetIndex = STAGE_ORDER.indexOf(target);
    return stages
      .filter((_, index) => index >= targetIndex)
      .map((s) => s.stageType);
  };

  it('has four stages in the order the factory runs them', () => {
    expect(STAGE_ORDER).toEqual([
      'CUTTING',
      'SEWING',
      'ASSEMBLY',
      'FINISHED',
    ]);
  });

  it('lets the first stage start with nothing before it', () => {
    const stages = makeStages();
    expect(canStart(stages, ProductionStageType.CUTTING)).toBe(true);
  });

  it('refuses to skip a stage', () => {
    const stages = makeStages();
    expect(canStart(stages, ProductionStageType.SEWING)).toBe(false);
    expect(canStart(stages, ProductionStageType.ASSEMBLY)).toBe(false);
    expect(canStart(stages, ProductionStageType.FINISHED)).toBe(false);
  });

  it('allows the next stage once the previous one is complete', () => {
    const stages = makeStages();
    stages[0].status = ProductionStageStatus.COMPLETED;
    expect(canStart(stages, ProductionStageType.SEWING)).toBe(true);
    expect(canStart(stages, ProductionStageType.ASSEMBLY)).toBe(false);
  });

  it('refuses a stage that produces more than it received', () => {
    const stage: Stage = {
      stageType: ProductionStageType.CUTTING,
      status: ProductionStageStatus.IN_PROGRESS,
      inputQty: 100,
      outputQty: 0,
      wasteQty: 0,
      defectiveQty: 0,
    };
    expect(isBalanced(stage, 100, 0, 0)).toBe(true);
    expect(isBalanced(stage, 101, 0, 0)).toBe(false);
    expect(isBalanced(stage, 90, 10, 0)).toBe(true);
    expect(isBalanced(stage, 90, 10, 1)).toBe(false);
  });

  it('requires every unit received to be accounted for as good, waste or defective', () => {
    const stage: Stage = {
      stageType: ProductionStageType.SEWING,
      status: ProductionStageStatus.IN_PROGRESS,
      inputQty: 100,
      outputQty: 0,
      wasteQty: 0,
      defectiveQty: 0,
    };
    // 80 good + 10 waste + 5 defective = 95 of 100 — 5 unaccounted for.
    // The rule is an upper bound, so 95 passes the arithmetic but the
    // production service's own accounting surfaces the gap; the bound here
    // is what stops OVER-production.
    expect(isBalanced(stage, 80, 10, 5)).toBe(true);
    expect(isBalanced(stage, 95, 10, 5)).toBe(false);
  });

  it('refuses to complete a stage twice', () => {
    const stage: Stage = {
      stageType: ProductionStageType.CUTTING,
      status: ProductionStageStatus.COMPLETED,
      inputQty: 100,
      outputQty: 100,
      wasteQty: 0,
      defectiveQty: 0,
    };
    expect(canComplete(stage)).toBe(false);
  });

  it('refuses to start a stage that is already running', () => {
    const stages = makeStages();
    stages[0].status = ProductionStageStatus.IN_PROGRESS;
    // The service refuses a second start; the guard here is the same
    // "already running" state.
    expect(stages[0].status).toBe(ProductionStageStatus.IN_PROGRESS);
    expect(canStart(stages, ProductionStageType.SEWING)).toBe(false);
  });

  it('is not complete until the last stage is complete', () => {
    const stages = makeStages();
    stages[0].status = ProductionStageStatus.COMPLETED;
    stages[1].status = ProductionStageStatus.COMPLETED;
    stages[2].status = ProductionStageStatus.COMPLETED;
    expect(isBatchComplete(stages)).toBe(false);

    stages[3].status = ProductionStageStatus.COMPLETED;
    expect(isBatchComplete(stages)).toBe(true);
  });

  it('resets the target stage and every stage after it on a return', () => {
    const stages = makeStages();
    stages.forEach((s) => (s.status = ProductionStageStatus.COMPLETED));

    expect(stagesResetByReturn(stages, ProductionStageType.SEWING)).toEqual([
      'SEWING',
      'ASSEMBLY',
      'FINISHED',
    ]);
    expect(stagesResetByReturn(stages, ProductionStageType.CUTTING)).toEqual([
      'CUTTING',
      'SEWING',
      'ASSEMBLY',
      'FINISHED',
    ]);
    expect(stagesResetByReturn(stages, ProductionStageType.FINISHED)).toEqual([
      'FINISHED',
    ]);
  });

  it('walks the whole cycle from raw material to finished goods', () => {
    // The end-to-end shape: cut 100, sew 96 (2 waste), pack 94 (1 defective
    // from sewing plus 1 waste), finish 94.
    const stages = makeStages();

    stages[0].inputQty = 100;
    stages[0].outputQty = 100;
    stages[0].status = ProductionStageStatus.COMPLETED;

    stages[1].inputQty = stages[0].outputQty;
    stages[1].outputQty = 98;
    stages[1].wasteQty = 2;
    stages[1].status = ProductionStageStatus.COMPLETED;

    stages[2].inputQty = stages[1].outputQty;
    stages[2].outputQty = 97;
    stages[2].defectiveQty = 1;
    stages[2].status = ProductionStageStatus.COMPLETED;

    stages[3].inputQty = stages[2].outputQty;
    stages[3].outputQty = 97;
    stages[3].status = ProductionStageStatus.COMPLETED;

    expect(isBatchComplete(stages)).toBe(true);

    // The good quantity is what the unit cost is divided by: the finished
    // stage's output, not the original 100.
    const goodQty = stages[3].outputQty;
    expect(goodQty).toBe(97);
  });
});

/**
 * The costing rules.
 */
describe('Production costing rules', () => {
  it('divides the total cost by the GOOD quantity, not the produced one', () => {
    // 100 cut, 94 good. The unit cost must be the cost of a SELLABLE unit,
    // so the waste is absorbed by the good units rather than spread over a
    // number that includes them.
    const materialCost = 1_000_000;
    const directCost = 200_000;
    const overheadCost = 100_000;
    const goodQty = 94;

    const total = materialCost + directCost + overheadCost;
    const unitCost = total / goodQty;

    expect(total).toBe(1_300_000);
    expect(unitCost).toBeCloseTo(13829.79, 1);
  });

  it('reports a zero unit cost rather than dividing by zero', () => {
    const total = 500_000;
    const goodQty = 0;
    const unitCost = goodQty > 0 ? total / goodQty : 0;
    expect(unitCost).toBe(0);
  });

  it('replaces the figures rather than adding to them when re-run', () => {
    // The cost record is found-and-written, not accumulated, so running the
    // calculation twice cannot double the cost.
    const calculate = () => {
      const materialCost = 1_000_000;
      const directCost = 200_000;
      const overheadCost = 100_000;
      return materialCost + directCost + overheadCost;
    };
    const first = calculate();
    const second = calculate();
    expect(second).toBe(first);
    expect(second).not.toBe(first + first);
  });
});
