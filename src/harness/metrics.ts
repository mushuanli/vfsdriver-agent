import {FSError} from '@itookit/vfs-core';

export interface HarnessMetrics {
    observedAt: number;
    contextWindow?: {limitTokens: number; usedTokens?: number | null; observedAt?: number};
    cost?: {amountUsd: number; kind: 'native-estimate'};
    quota?: {windows: Array<{id: string; usedPercent?: number | null; status?: 'allowed' | 'allowed_warning' | 'rejected'; windowMinutes?: number | null; resetsAt?: number | null}>; creditBalance?: string | null; unlimited?: boolean | null};
    errors?: {context?: string; quota?: string};
}
const invalid = () => new FSError('EIO', 'Invalid native metrics');
const integer = (value: unknown): value is number => Number.isSafeInteger(value) && (value as number) >= 0;
function validateWindow(value: NonNullable<HarnessMetrics['quota']>['windows'][number]) {
    if (!value || typeof value.id !== 'string' || !value.id || value.id.length > 128 || /[\x00-\x1f\x7f]/.test(value.id)
        || value.usedPercent != null && (!Number.isFinite(value.usedPercent) || value.usedPercent < 0 || value.usedPercent > 100)
        || value.status !== undefined && !['allowed', 'allowed_warning', 'rejected'].includes(value.status)
        || value.windowMinutes != null && !integer(value.windowMinutes) || value.resetsAt != null && (!integer(value.resetsAt) || value.resetsAt > 8.64e15)) throw invalid();
    return {id: value.id, usedPercent: value.usedPercent, status: value.status, windowMinutes: value.windowMinutes, resetsAt: value.resetsAt};
}
export function validateMetrics(value: unknown): HarnessMetrics {
    const row = value as HarnessMetrics;
    if (!row || !integer(row.observedAt) || !row.observedAt) throw invalid();
    const context = row.contextWindow, cost = row.cost, quota = row.quota;
    if (context && (!integer(context.limitTokens) || !context.limitTokens || context.usedTokens != null && !integer(context.usedTokens)
        || context.observedAt !== undefined && !integer(context.observedAt))) throw invalid();
    if (cost && (!Number.isFinite(cost.amountUsd) || cost.amountUsd < 0 || cost.amountUsd > Number.MAX_SAFE_INTEGER || cost.kind !== 'native-estimate')) throw invalid();
    if (quota && (!Array.isArray(quota.windows) || quota.windows.length > 64
        || quota.creditBalance != null && (typeof quota.creditBalance !== 'string' || !/^\d+(?:\.\d+)?$/.test(quota.creditBalance) || quota.creditBalance.length > 64)
        || quota.unlimited != null && typeof quota.unlimited !== 'boolean')) throw invalid();
    if (row.errors && Object.values(row.errors).some(code => typeof code !== 'string' || !/^[A-Z][A-Z0-9_]{0,79}$/.test(code))) throw invalid();
    return {observedAt: row.observedAt,
        ...(context ? {contextWindow: {limitTokens: context.limitTokens, usedTokens: context.usedTokens, observedAt: context.observedAt}} : {}),
        ...(cost ? {cost: {amountUsd: cost.amountUsd, kind: cost.kind}} : {}),
        ...(quota ? {quota: {windows: quota.windows.map(validateWindow), creditBalance: quota.creditBalance, unlimited: quota.unlimited}} : {}),
        ...(row.errors ? {errors: {context: row.errors.context, quota: row.errors.quota}} : {})};
}

/** Consume native observations directly; cumulative totals never represent current occupancy. */
export function observeContextMetrics(current: HarnessMetrics | undefined, value: unknown, observedAt: number): HarnessMetrics {
    if (!value || typeof value !== 'object') throw invalid();
    const raw = value as {modelContextWindow?: unknown; last?: {totalTokens?: unknown}};
    const limit = raw.modelContextWindow, used = raw.last?.totalTokens;
    const contextWindow = limit == null ? undefined : {limitTokens: limit as number, usedTokens: used == null ? null : used as number, observedAt};
    const errors = current?.errors ? {...current.errors} : undefined;
    if (errors) delete errors.context;
    return validateMetrics({...current, observedAt, contextWindow, errors});
}
