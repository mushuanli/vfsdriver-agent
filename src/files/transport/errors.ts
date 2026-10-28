import { FSError, type FSErrorCode } from '@itookit/vfs-core';
import { boundedBody } from './body';

export class HttpResponseError extends FSError {
    constructor(code: FSErrorCode, message: string, readonly status: number, readonly remoteCode?: string) { super(code, message); }
    get httpStatus(): number { return this.status; }
}

export async function responseError(response: Response): Promise<FSError> {
    let declared: unknown, message: unknown;
    try {
        const payload = JSON.parse(new TextDecoder().decode(await boundedBody(response, 64 * 1024))) as { code?: unknown; message?: unknown };
        declared = payload.code; message = payload.message;
    } catch { /* an empty body or an HTML proxy response: the status code is the only evidence */ }
    const detail = typeof declared === 'string' && /^[A-Z][A-Z0-9_]{1,79}$/.test(declared) ? declared : undefined;
    return new HttpResponseError(remoteCode(declared, statusCode(response.status)),
        typeof message === 'string' && message ? message : `File server returned ${response.status}${detail ? ` (${detail})` : ''}`, response.status, detail);
}

const STATUS_CODES: Record<number, FSErrorCode> = { 400: 'EINVAL', 401: 'EACCES', 403: 'EACCES', 404: 'ENOENT', 409: 'EEXIST',
    412: 'ECONFLICT', 413: 'EINVAL', 416: 'EINVAL', 422: 'ECAPABILITY', 428: 'EINVAL', 429: 'EBUSY', 501: 'ECAPABILITY',
    503: 'EBUSY', 504: 'ETIMEDOUT', 507: 'ENOSPC' };

export function statusCode(status: number): FSErrorCode { return STATUS_CODES[status] ?? 'EIO'; }

export function remoteCode(value: unknown, fallback: FSErrorCode = 'EIO'): FSErrorCode {
    const known: FSErrorCode[] = ['ECONFLICT', 'EEXIST', 'ENOENT', 'ENOTDIR', 'EISDIR', 'ENOTEMPTY', 'EROFS', 'EACCES', 'EINVAL', 'ECAPABILITY', 'ECANCELLED', 'ETIMEDOUT', 'EBUSY', 'ENOSPC'];
    return known.includes(value as FSErrorCode) ? value as FSErrorCode : fallback;
}
