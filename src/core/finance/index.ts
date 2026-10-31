// Finance aggregate barrel: legacy booking/invoice serializers (pre-Phase 1,
// kept API-identical for existing routes) plus Phase 1 finance modules.
export { serializeBookings, listBookings, listInvoices } from './legacy';
export { writeAuditEvent, queryAuditEvents } from './audit';
export type { AuditWrite, AuditQuery } from './audit';
export { publishFinanceEvent, markEventConsumed, markEventFailed, claimStripeEvent, FINANCE_EVENT_TYPES } from './events';
export type { FinanceEventType, FinanceEventWrite } from './events';
export { getIdempotencyKey, newCorrelationId, assertFreshVersion, nextVersion } from './idempotency';
export { getFinancePolicies, requireDecided, FINANCE_KEYS } from './policies';
export type { FinancePolicies } from './policies';
export { getFinanceOverview, overviewExportCsv } from './overview';
export type { OverviewBasis, OverviewOpts, OverviewKpi } from './overview';
export { project, weightedPsf, annualisedIrr, applyScenario, sensitivity, stableStringify, hashInput, openingPeriodFactor, ENGINE_VERSION } from './projection';
export type { ProjectionInput, ProjectionMonth, ProjectionKpis, ProjectionResult, ScenarioName, ScenarioOverlay, SensitivityCase, YearSummary } from './projection';
export {
  listModels, getModel, createModel, updateModelSection, deleteModel, modelExportCsv, defaultModelInputs,
  MODEL_STATUSES,
} from './models';
export type { ModelSummary, ModelDetail, ModelSection, ModelStatus } from './models';
export {
  listLibrary, saveVersion, duplicateModel, submitModel, approveModel, rejectModel,
  restoreVersion, archiveModel, setCurrentModel, listVersions, modelAuditHistory,
  validateSubmittable, inventoryMappingProblems, VERSION_STATUSES,
} from './library';
export {
  listBudgets, createBudget, updateBudget, listExpenses, recordExpense, expensesExportCsv,
  isProtectedCategory, fiscalMonthOf, updateExpense, EXPENSE_STATUSES,
} from './budgets';
export { getPricing, overridePricing, bucketForSize, CANONICAL_BUCKETS } from './pricing';
export type { PricingRow } from './pricing';
export { getReturns, DEFAULT_DISCOUNT_RATE_PCT } from './returns';
export {
  listFinanceInvoices, getInvoiceDetail, createInvoice, approveInvoice, issueInvoice,
  voidInvoice, runBilling, serializeInvoice, INVOICE_LINE_KINDS,
} from './billing';
export type { InvoiceRow, InvoiceLineInput, CreateInvoiceInput, BillingRunInput, BillingRunResult } from './billing';
export {
  listInstructions, getInstructionDetail, createInstruction, approveInstruction, cancelInstruction,
  submitInstruction, applyInstructionPaymentSucceeded, applyInstructionPaymentFailed,
  serializeInstruction,
} from './payments';
export type { InstructionRow, InstructionDetail, CreateInstructionInput } from './payments';
export { writeOffInvoice } from './billing';
export {
  calculateRefund, getWallet, grantCredit, applyCredit, listRefunds, getRefund,
  requestRefund, approveRefund, rejectRefund, verifyRefundBank, payRefund,
  serializeWallet, serializeRefund, LEDGER_KINDS, REFUND_STATUSES, listCreditLedger,
} from './credits';
export type { RefundCalculation, RefundCalculationInput, WalletRow, RefundRow, RequestRefundInput, GrantCreditInput, ApplyCreditInput, DecideRefundOpts } from './credits';
export {
  listArrearsCases, listArrearsCandidates, openArrearsCase, advanceArrearsCase, closeArrearsCase,
  getArrearsCase,
  requestTerminationHelp, listWaivers, requestWaiver, decideWaiver, resolveLateFee,
  ARREARS_STAGES,
} from './arrears';
export type { ArrearsCaseRow, WaiverRow } from './arrears';
export {
  importSettlement, matchSettlement, suspenseSettlement, getReconciliation,
  closeReconciliationBatch, reopenReconciliationBatch, serializeSettlement, IMPORT_STATUSES,
} from './reconciliation';
export type { SettlementRow, SettlementLineInput, ImportSettlementInput, ReconciliationSummary } from './reconciliation';
export {
  isMonthClosed, computeActuals, closeChecklist, getMonthClose, closeMonth, postCloseAdjustment,
  getPerformance, addVarianceNote, parseFiscalMonth, ACTUAL_METRICS, getPerformanceSeries,
} from './monthClose';
export type { ActualLine, CloseCheck, MonthCloseRow, PerformanceView, PerformanceRow } from './monthClose';
