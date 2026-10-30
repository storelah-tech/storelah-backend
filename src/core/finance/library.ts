// Model Library — versions + governance (FINANCE_MODULE_SPEC §16).
//
// Cards = FinancialModel rows with their latest version + headline results
// (computed live by the pure engine — loading a version changes the forecast,
// charts, cash and returns, never posted actuals, §16.4). Every transition
// writes a FinanceAuditEvent + FinanceEvent in the same transaction; history
// rows are immutable (restore/duplicate always create NEW rows, §16.3).
//
// Approval gates (§11.8 + §14.2): submit validates size-mix reconciliation,
// lease-year coverage and rent non-negativity; approve additionally requires
// the inventory mapping gate when the model is facility-scoped (every size
// category must map to live UnitSize rows — missing mapping blocks approval,
// never viewing).

import { Prisma } from '@prisma/client';
import { prisma } from '../../lib/prisma';
import { AppError } from '../../lib/http';
import { writeAuditEvent } from './audit';
import { publishFinanceEvent } from './events';
import { assertFreshVersion, nextVersion, newCorrelationId } from './idempotency';
import { projectModel } from './models';
import { project, type ProjectionInput } from './projection';

const VERSION_STATUSES = ['DRAFT', 'SUBMITTED', 'APPROVED', 'REJECTED', 'ARCHIVED'] as const;

function toInputs(raw: unknown): ProjectionInput {
  return raw as ProjectionInput;
}

async function latestVersionRow(modelId: string) {
  return prisma.financialModelVersion.findFirst({
    where: { modelId },
    orderBy: { version: 'desc' },
  });
}

/** Library cards: model + latest version + headline assumptions/results. */
export async function listLibrary(opts: { branchId?: string; status?: string; search?: string } = {}) {
  const models = await prisma.financialModel.findMany({
    where: {
      ...(opts.branchId ? { branchId: opts.branchId } : {}),
      ...(opts.status ? { status: opts.status.toUpperCase() } : {}),
      ...(opts.search ? { name: { contains: opts.search, mode: 'insensitive' } } : {}),
    },
    orderBy: { updatedAt: 'desc' },
    take: 200,
    include: { versions: { orderBy: { version: 'desc' }, take: 1 } },
  });
  return models.map((m) => {
    const latest = m.versions[0] ?? null;
    let headline: Record<string, unknown> = {};
    try {
      const res = projectModel(toInputs(m.inputs));
      const y1 = res.kpis.years[0];
      headline = {
        year1Noi: y1?.noi ?? null,
        year1Revenue: y1?.revenue ?? null,
        paybackMonth: res.kpis.paybackMonth,
        irrAnnualised: res.kpis.irrAnnualised,
        stabilisedMonth: res.kpis.stabilisedMonth,
        inputHash: res.inputHash,
      };
    } catch {
      headline = { error: 'Stored inputs no longer project — restore a prior version.' };
    }
    return {
      id: m.id,
      branchId: m.branchId,
      name: m.name,
      status: m.status,
      version: m.version,
      engineVersion: m.engineVersion,
      inputHash: m.inputHash,
      latestVersion: latest
        ? { version: latest.version, status: latest.status, changeSummary: latest.changeSummary, createdBy: latest.createdBy, createdAt: latest.createdAt }
        : null,
      updatedBy: m.updatedBy,
      updatedAt: m.updatedAt,
      createdAt: m.createdAt,
      headline,
    };
  });
}

/** Validates a version snapshot for the submit gate (§11.8). */
export function validateSubmittable(inputs: ProjectionInput): string[] {
  const problems: string[] = [];
  const mixTotal = inputs.sizeMix.reduce((s, c) => s + c.nlaSqft, 0);
  if (Math.abs(mixTotal - inputs.nlaSqft) > 0.01) {
    problems.push(`Size-mix NLA ${mixTotal} does not reconcile to facility NLA ${inputs.nlaSqft}.`);
  }
  const needYears = Math.ceil(inputs.horizonMonths / 12);
  if (inputs.lease.monthlyByYear.length < needYears) {
    problems.push(`Lease schedule covers ${inputs.lease.monthlyByYear.length} year(s) but the horizon needs ${needYears} — extend it or select an explicit carry-forward.`);
  }
  if (inputs.lease.monthlyByYear.some((r) => r < 0)) problems.push('Lease rent values cannot be negative.');
  return problems;
}

/** Inventory-mapping gate (§14.2): every size category must map to live sizes. */
const SIZE_LABEL_ALIAS: Record<string, string> = { XS: 'LOCKER', S: 'SMALL', M: 'MEDIUM', L: 'LARGE' };

export async function inventoryMappingProblems(modelId: string): Promise<string[]> {
  const m = await prisma.financialModel.findUnique({ where: { id: modelId } });
  if (!m || !m.branchId) return [];
  const inputs = toInputs(m.inputs);
  const sizes = await prisma.unitSize.findMany({ select: { code: true } });
  const live = new Set(sizes.map((s) => s.code.trim().toUpperCase()));
  const missing = inputs.sizeMix
    .map((c) => c.name)
    .filter((name) => {
      const n = name.trim().toUpperCase();
      if (live.has(n)) return false;
      // Short planning labels read as the canonical live buckets (XS was the
      // legacy LOCKER alias, IMPLEMENTATION_PLAN §6 Q9; S/M/L are the
      // prototype's size-mix labels).
      const alias = SIZE_LABEL_ALIAS[n];
      if (alias && live.has(alias)) return false;
      return true;
    });
  if (sizes.length === 0) return ['No live UnitSize inventory exists for this facility — sync inventory before approval.'];
  return missing.map((name) => `Size category "${name}" has no live UnitSize mapping — sync inventory before approval.`);
}

/** Saves the committed inputs as a named version snapshot (§16.2). */
export async function saveVersion(opts: {
  modelId: string; name?: string; changeSummary: string; actor: string; correlationId?: string;
}) {
  const m = await prisma.financialModel.findUnique({ where: { id: opts.modelId } });
  if (!m) throw new AppError(404, 'NOT_FOUND', `Financial model ${opts.modelId} not found.`);
  if (!opts.changeSummary.trim()) throw new AppError(400, 'VALIDATION', 'A change note/purpose is required to save a version.');
  const correlationId = opts.correlationId ?? newCorrelationId();
  const next = (await latestVersionRow(m.id))?.version ?? -1;
  const saved = await prisma.$transaction(async (tx) => {
    const v = await tx.financialModelVersion.create({
      data: {
        modelId: m.id,
        version: next + 1,
        snapshot: m.inputs as unknown as Prisma.InputJsonValue,
        changeSummary: opts.changeSummary.trim(),
        status: m.status === 'CURRENT' ? 'APPROVED' : 'DRAFT',
        createdBy: opts.actor,
      },
    });
    await writeAuditEvent(tx, {
      branchId: m.branchId, actor: opts.actor, action: 'MODEL_VERSION_SAVED',
      entityType: 'financial-model', entityId: m.id,
      after: { version: v.version, changeSummary: v.changeSummary, inputHash: m.inputHash },
      reason: opts.changeSummary.trim(), source: 'cms', correlationId,
    });
    await publishFinanceEvent(tx, {
      type: 'model.version.saved', payload: { modelId: m.id, version: v.version },
      branchId: m.branchId, correlationId,
    });
    return v;
  });
  return { id: saved.id, modelId: m.id, version: saved.version, status: saved.status, changeSummary: saved.changeSummary, createdAt: saved.createdAt };
}

/** Duplicates a model as an independent DRAFT (prompts for name + reason). */
export async function duplicateModel(opts: { modelId: string; name: string; reason: string; actor: string }) {
  const m = await prisma.financialModel.findUnique({ where: { id: opts.modelId } });
  if (!m) throw new AppError(404, 'NOT_FOUND', `Financial model ${opts.modelId} not found.`);
  if (!opts.name.trim()) throw new AppError(400, 'VALIDATION', 'A new name is required to duplicate a model.');
  if (!opts.reason.trim()) throw new AppError(400, 'VALIDATION', 'A reason is required to duplicate a model.');
  const correlationId = newCorrelationId();
  const inputs = toInputs(m.inputs);
  project(inputs); // must still project — never duplicate a corrupt snapshot
  const created = await prisma.$transaction(async (tx) => {
    const dup = await tx.financialModel.create({
      data: {
        branchId: m.branchId,
        name: opts.name.trim(),
        status: 'DRAFT',
        inputs: m.inputs as unknown as Prisma.InputJsonValue,
        engineVersion: m.engineVersion,
        inputHash: m.inputHash,
        createdBy: opts.actor,
        updatedBy: opts.actor,
        version: 0,
      },
    });
    await tx.financialModelVersion.create({
      data: {
        modelId: dup.id, version: 0, snapshot: m.inputs as unknown as Prisma.InputJsonValue,
        changeSummary: `Duplicated from "${m.name}" — ${opts.reason.trim()}`,
        status: 'DRAFT', createdBy: opts.actor,
      },
    });
    await writeAuditEvent(tx, {
      branchId: dup.branchId, actor: opts.actor, action: 'MODEL_DUPLICATED',
      entityType: 'financial-model', entityId: dup.id,
      after: { fromModelId: m.id, name: dup.name },
      reason: opts.reason.trim(), source: 'cms', correlationId,
    });
    await publishFinanceEvent(tx, {
      type: 'model.updated', payload: { modelId: dup.id, duplicatedFrom: m.id },
      branchId: dup.branchId, correlationId,
    });
    return dup;
  });
  return { id: created.id, name: created.name, status: created.status, version: created.version };
}

/** Submits the working revision for approval (locks the model to PENDING). */
export async function submitModel(opts: { modelId: string; expectedVersion?: number; actor: string; changeSummary?: string }) {
  const m = await prisma.financialModel.findUnique({ where: { id: opts.modelId } });
  if (!m) throw new AppError(404, 'NOT_FOUND', `Financial model ${opts.modelId} not found.`);
  if (m.status !== 'DRAFT') throw new AppError(403, 'LOCKED', `Model "${m.name}" is ${m.status} — only DRAFT models can be submitted.`);
  assertFreshVersion(m.version, opts.expectedVersion, 'FinancialModel');
  const inputs = toInputs(m.inputs);
  const problems = validateSubmittable(inputs);
  if (problems.length) {
    throw new AppError(409, 'BLOCKED', `Model "${m.name}" is not submittable: ${problems.join(' ')}`, { problems });
  }
  const correlationId = newCorrelationId();
  const updated = await prisma.$transaction(async (tx) => {
    const u = await tx.financialModel.update({
      where: { id: m.id },
      data: { status: 'PENDING', updatedBy: opts.actor, version: nextVersion(m.version) },
    });
    await tx.financialModelVersion.create({
      data: {
        modelId: m.id, version: ((await latestVersionRow(m.id))?.version ?? -1) + 1,
        snapshot: m.inputs as unknown as Prisma.InputJsonValue, changeSummary: opts.changeSummary?.trim() || 'Submitted for approval',
        status: 'SUBMITTED', createdBy: opts.actor,
      },
    });
    await writeAuditEvent(tx, {
      branchId: m.branchId, actor: opts.actor, action: 'MODEL_SUBMITTED',
      entityType: 'financial-model', entityId: m.id,
      before: { status: 'DRAFT', version: m.version }, after: { status: 'PENDING', version: u.version },
      reason: opts.changeSummary?.trim() || 'Submitted for approval', source: 'cms', correlationId,
    });
    await publishFinanceEvent(tx, {
      type: 'model.submitted', payload: { modelId: m.id }, branchId: m.branchId, correlationId,
    });
    return u;
  });
  return { id: updated.id, status: updated.status, version: updated.version };
}

async function decideModel(opts: {
  modelId: string; approve: boolean; expectedVersion?: number; actor: string; comment?: string;
}) {
  const m = await prisma.financialModel.findUnique({ where: { id: opts.modelId } });
  if (!m) throw new AppError(404, 'NOT_FOUND', `Financial model ${opts.modelId} not found.`);
  if (m.status !== 'PENDING') {
    throw new AppError(403, 'LOCKED', `Model "${m.name}" is ${m.status} — only PENDING models can be ${opts.approve ? 'approved' : 'rejected'}.`);
  }
  assertFreshVersion(m.version, opts.expectedVersion, 'FinancialModel');
  if (opts.approve) {
    const gate = await inventoryMappingProblems(m.id);
    if (gate.length) {
      throw new AppError(409, 'BLOCKED', `Approval blocked — missing inventory mapping: ${gate.join(' ')}`, { problems: gate });
    }
  }
  const correlationId = newCorrelationId();
  const updated = await prisma.$transaction(async (tx) => {
    const u = await tx.financialModel.update({
      where: { id: m.id },
      data: { status: opts.approve ? 'CURRENT' : 'DRAFT', updatedBy: opts.actor, version: nextVersion(m.version) },
    });
    // A new CURRENT baseline supersedes any other CURRENT model on the branch.
    if (opts.approve) {
      const others = await tx.financialModel.findMany({
        where: { status: 'CURRENT', id: { not: m.id }, ...(m.branchId ? { branchId: m.branchId } : { branchId: null }) },
      });
      for (const o of others) {
        await tx.financialModel.update({ where: { id: o.id }, data: { status: 'ARCHIVED', updatedBy: opts.actor } });
        await writeAuditEvent(tx, {
          branchId: o.branchId, actor: opts.actor, action: 'MODEL_SUPERSEDED',
          entityType: 'financial-model', entityId: o.id,
          before: { status: 'CURRENT' }, after: { status: 'ARCHIVED', supersededBy: m.id },
          reason: `Superseded by approval of "${m.name}"`, source: 'cms', correlationId,
        });
      }
    }
    await tx.financialModelVersion.create({
      data: {
        modelId: m.id, version: ((await latestVersionRowTx(tx, m.id))?.version ?? -1) + 1,
        snapshot: m.inputs as unknown as Prisma.InputJsonValue, changeSummary: opts.comment?.trim() || (opts.approve ? 'Approved' : 'Rejected'),
        status: opts.approve ? 'APPROVED' : 'REJECTED',
        decidedBy: opts.actor, decidedAt: new Date(), createdBy: opts.actor,
      },
    });
    await writeAuditEvent(tx, {
      branchId: m.branchId, actor: opts.actor,
      action: opts.approve ? 'MODEL_APPROVED' : 'MODEL_REJECTED',
      entityType: 'financial-model', entityId: m.id,
      before: { status: 'PENDING', version: m.version },
      after: { status: u.status, version: u.version },
      reason: opts.comment?.trim() || (opts.approve ? 'Approved' : 'Rejected'),
      source: 'cms', correlationId,
    });
    await publishFinanceEvent(tx, {
      type: opts.approve ? 'model.approved' : 'model.updated',
      payload: { modelId: m.id, decidedBy: opts.actor, decision: opts.approve ? 'approved' : 'rejected' },
      branchId: m.branchId, correlationId,
    });
    return u;
  });
  return { id: updated.id, status: updated.status, version: updated.version };
}

async function latestVersionRowTx(tx: Pick<typeof prisma, 'financialModelVersion'>, modelId: string) {
  return tx.financialModelVersion.findFirst({ where: { modelId }, orderBy: { version: 'desc' } });
}

export function approveModel(opts: { modelId: string; expectedVersion?: number; actor: string; comment?: string }) {
  return decideModel({ ...opts, approve: true });
}

export function rejectModel(opts: { modelId: string; expectedVersion?: number; actor: string; comment?: string }) {
  return decideModel({ ...opts, approve: false });
}

/** Restores a historical snapshot as a NEW draft (history is never overwritten). */
export async function restoreVersion(opts: { modelId: string; version: number; reason: string; actor: string }) {
  const m = await prisma.financialModel.findUnique({ where: { id: opts.modelId } });
  if (!m) throw new AppError(404, 'NOT_FOUND', `Financial model ${opts.modelId} not found.`);
  if (!opts.reason.trim()) throw new AppError(400, 'VALIDATION', 'A reason is required to restore a version.');
  const snap = await prisma.financialModelVersion.findUnique({
    where: { modelId_version: { modelId: opts.modelId, version: opts.version } },
  });
  if (!snap) throw new AppError(404, 'NOT_FOUND', `Version ${opts.version} of model ${opts.modelId} not found.`);
  const inputs = toInputs(snap.snapshot);
  project(inputs); // must still project
  const correlationId = newCorrelationId();
  const created = await prisma.$transaction(async (tx) => {
    const dup = await tx.financialModel.create({
      data: {
        branchId: m.branchId, name: `${m.name} (restore v${snap.version})`, status: 'DRAFT',
        inputs: snap.snapshot as unknown as Prisma.InputJsonValue, engineVersion: m.engineVersion,
        inputHash: (await import('./projection')).hashInput(inputs),
        createdBy: opts.actor, updatedBy: opts.actor, version: 0,
      },
    });
    await tx.financialModelVersion.create({
      data: {
        modelId: dup.id, version: 0, snapshot: snap.snapshot as unknown as Prisma.InputJsonValue,
        changeSummary: `Restored from "${m.name}" v${snap.version} — ${opts.reason.trim()}`,
        status: 'DRAFT', createdBy: opts.actor,
      },
    });
    await writeAuditEvent(tx, {
      branchId: m.branchId, actor: opts.actor, action: 'MODEL_RESTORED',
      entityType: 'financial-model', entityId: dup.id,
      after: { fromModelId: m.id, fromVersion: snap.version },
      reason: opts.reason.trim(), source: 'cms', correlationId,
    });
    await publishFinanceEvent(tx, {
      type: 'model.version.loaded', payload: { modelId: dup.id, fromModelId: m.id, fromVersion: snap.version },
      branchId: m.branchId, correlationId,
    });
    return dup;
  });
  return { id: created.id, name: created.name, status: created.status };
}

/** Archives a non-CURRENT model (confirmation is a UI concern). */
export async function archiveModel(opts: { modelId: string; expectedVersion?: number; actor: string; reason?: string }) {
  const m = await prisma.financialModel.findUnique({ where: { id: opts.modelId } });
  if (!m) throw new AppError(404, 'NOT_FOUND', `Financial model ${opts.modelId} not found.`);
  if (m.status === 'CURRENT') {
    throw new AppError(403, 'LOCKED', `Model "${m.name}" is the CURRENT baseline — set another model as Current before archiving it.`);
  }
  assertFreshVersion(m.version, opts.expectedVersion, 'FinancialModel');
  const correlationId = newCorrelationId();
  const updated = await prisma.$transaction(async (tx) => {
    const u = await tx.financialModel.update({
      where: { id: m.id }, data: { status: 'ARCHIVED', updatedBy: opts.actor, version: nextVersion(m.version) },
    });
    await writeAuditEvent(tx, {
      branchId: m.branchId, actor: opts.actor, action: 'MODEL_ARCHIVED',
      entityType: 'financial-model', entityId: m.id,
      before: { status: m.status, version: m.version }, after: { status: 'ARCHIVED', version: u.version },
      reason: opts.reason?.trim() || 'Archived', source: 'cms', correlationId,
    });
    await publishFinanceEvent(tx, {
      type: 'model.updated', payload: { modelId: m.id, archived: true }, branchId: m.branchId, correlationId,
    });
    return u;
  });
  return { id: updated.id, status: updated.status, version: updated.version };
}

/** Sets an approved model as the CURRENT baseline forecast. */
export async function setCurrentModel(opts: { modelId: string; expectedVersion?: number; actor: string }) {
  const m = await prisma.financialModel.findUnique({ where: { id: opts.modelId } });
  if (!m) throw new AppError(404, 'NOT_FOUND', `Financial model ${opts.modelId} not found.`);
  assertFreshVersion(m.version, opts.expectedVersion, 'FinancialModel');
  const correlationId = newCorrelationId();
  const updated = await prisma.$transaction(async (tx) => {
    const others = await tx.financialModel.findMany({
      where: { status: 'CURRENT', id: { not: m.id }, ...(m.branchId ? { branchId: m.branchId } : { branchId: null }) },
    });
    for (const o of others) {
      await tx.financialModel.update({ where: { id: o.id }, data: { status: 'ARCHIVED', updatedBy: opts.actor } });
      await writeAuditEvent(tx, {
        branchId: o.branchId, actor: opts.actor, action: 'MODEL_SUPERSEDED',
        entityType: 'financial-model', entityId: o.id,
        before: { status: 'CURRENT' }, after: { status: 'ARCHIVED', supersededBy: m.id },
        reason: `"${m.name}" set as Current`, source: 'cms', correlationId,
      });
    }
    const u = await tx.financialModel.update({
      where: { id: m.id }, data: { status: 'CURRENT', updatedBy: opts.actor, version: nextVersion(m.version) },
    });
    await writeAuditEvent(tx, {
      branchId: m.branchId, actor: opts.actor, action: 'MODEL_SET_CURRENT',
      entityType: 'financial-model', entityId: m.id,
      before: { status: m.status, version: m.version }, after: { status: 'CURRENT', version: u.version },
      reason: `"${m.name}" set as the Current baseline`, source: 'cms', correlationId,
    });
    await publishFinanceEvent(tx, {
      type: 'model.version.loaded', payload: { modelId: m.id, setCurrent: true },
      branchId: m.branchId, correlationId,
    });
    return u;
  });
  return { id: updated.id, status: updated.status, version: updated.version };
}

/** Version list for a model (newest first). */
export async function listVersions(modelId: string) {
  const m = await prisma.financialModel.findUnique({ where: { id: modelId } });
  if (!m) throw new AppError(404, 'NOT_FOUND', `Financial model ${modelId} not found.`);
  const rows = await prisma.financialModelVersion.findMany({
    where: { modelId }, orderBy: { version: 'desc' },
  });
  return rows.map((v) => ({
    id: v.id, modelId: v.modelId, version: v.version, status: v.status,
    changeSummary: v.changeSummary, decidedBy: v.decidedBy, decidedAt: v.decidedAt,
    createdBy: v.createdBy, createdAt: v.createdAt,
  }));
}

/** Full audit history for a model + its versions (append-only evidence, §16.5). */
export async function modelAuditHistory(modelId: string) {
  const m = await prisma.financialModel.findUnique({ where: { id: modelId } });
  if (!m) throw new AppError(404, 'NOT_FOUND', `Financial model ${modelId} not found.`);
  const versions = await prisma.financialModelVersion.findMany({ where: { modelId }, select: { id: true } });
  const ids = [modelId, ...versions.map((v) => v.id)];
  const rows = await prisma.financeAuditEvent.findMany({
    where: { entityType: 'financial-model', entityId: { in: ids } },
    orderBy: { occurredAt: 'desc' },
    take: 500,
  });
  return rows;
}

export { VERSION_STATUSES };
