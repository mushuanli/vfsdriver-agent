import {expect, it} from 'vitest';
import {validateWriterLock} from '../src/harness/writer-lock';
import {validateSession} from '../src/harness/validation';

it('retains current lock evidence separately from session execution and strips private fields', () => {
    const writerLock = {status: 'held' as const, checkedAt: 1793428000000, acquiredAt: null,
        owner: {pid: 42, uid: 1000, processStartedAt: 1793427000000, commandLine: 'private-command'}, path: '/private/home'};
    const session = validateSession({id: 's', title: '', cwd: null, status: 'idle', updatedAt: null, resumable: true, writerLock});
    expect(session.status).toBe('idle');
    expect(session.writerLock).toMatchObject({status: 'held', owner: {pid: 42, uid: 1000}, acquiredAt: null});
    expect(session.writerLock).not.toHaveProperty('path');
    expect(session.writerLock?.owner).not.toHaveProperty('commandLine');
    expect(validateWriterLock(undefined)).toBeUndefined();
    expect(validateWriterLock({status: 'unknown', checkedAt: writerLock.checkedAt, code: 'LOCK_TABLE_UNAVAILABLE'})).toMatchObject({status: 'unknown'});
});

it.each([
    {status: 'held', checkedAt: 1793428000000},
    {status: 'not-held', checkedAt: 1793428000000, owner: {pid: 42}},
    {status: 'held', checkedAt: 1793428000000, owner: {pid: -1}},
    {status: 'unknown', checkedAt: 0},
    {status: 'unknown', checkedAt: 1793428000000, code: 'private detail'},
])('rejects malformed or contradictory lock evidence: %j', value => {
    expect(() => validateWriterLock(value)).toThrow('Invalid writer lock observation');
});
