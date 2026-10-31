import {FSError} from '@itookit/vfs-core';
import type {HarnessWriterLock} from './contracts';

/** Keep only safe diagnostic fields; an absent observation never means unlocked. */
export function validateWriterLock(value: unknown): HarnessWriterLock | undefined {
    if (value === undefined) return;
    const lock = value as HarnessWriterLock;
    const validTime = (time: unknown) => time === undefined || time === null || typeof time === 'number' && Number.isSafeInteger(time) && time > 0;
    const validId = (id: unknown) => typeof id === 'number' && Number.isSafeInteger(id) && id >= 0;
    if (!lock || !['held', 'not-held', 'unknown'].includes(lock.status) || !lock.checkedAt || !validTime(lock.checkedAt)
        || !validTime(lock.acquiredAt) || !validTime(lock.lockFileModifiedAt)
        || lock.code !== undefined && (typeof lock.code !== 'string' || !/^[A-Z][A-Z0-9_]{0,79}$/.test(lock.code))
        || lock.status === 'held' && !lock.owner
        || lock.owner && (lock.status !== 'held' || !validId(lock.owner.pid) || !lock.owner.pid
            || lock.owner.uid != null && !validId(lock.owner.uid) || !validTime(lock.owner.processStartedAt)))
        throw new FSError('EIO', 'Invalid writer lock observation');
    const owner = lock.owner && {pid: lock.owner.pid, uid: lock.owner.uid, processStartedAt: lock.owner.processStartedAt};
    return {status: lock.status, checkedAt: lock.checkedAt, acquiredAt: lock.acquiredAt, lockFileModifiedAt: lock.lockFileModifiedAt, code: lock.code, owner};
}
