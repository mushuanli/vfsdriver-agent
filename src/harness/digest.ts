import {FSError} from '@itookit/vfs-core';
import {validateSession} from './validation';
import type {HarnessSession} from './contracts';

export interface HarnessDigestMessage {id: string; turnId?: string; role: 'user' | 'assistant'; text: string; timestamp?: number}
export interface HarnessSessionDigest {
    version: 1; session: HarnessSession; revision: string; messages: HarnessDigestMessage[];
    omittedUnclassified: number; nextCursor: string | null;
}
export function validateDigest(value: unknown, sessionId: string): HarnessSessionDigest {
    const row = value as HarnessSessionDigest;
    if (!row || row.version !== 1 || !/^[a-f0-9]{64}$/.test(row.revision) || !Array.isArray(row.messages) || row.messages.length > 10000
        || !Number.isSafeInteger(row.omittedUnclassified) || row.omittedUnclassified < 0
        || !(row.nextCursor === null || typeof row.nextCursor === 'string' && row.nextCursor.length > 0 && row.nextCursor.length <= 4096)) throw invalid();
    const session = validateSession(row.session);
    if (session.id !== sessionId) throw invalid();
    let bytes = 0;
    const messages = row.messages.map(message => {
        if (!message || typeof message.id !== 'string' || !message.id || message.id.length > 1024
            || !['user', 'assistant'].includes(message.role) || typeof message.text !== 'string'
            || message.turnId != null && (typeof message.turnId !== 'string' || message.turnId.length > 1024)
            || message.timestamp != null && (!Number.isFinite(message.timestamp) || message.timestamp < 0)) throw invalid();
        bytes += new TextEncoder().encode(message.text).length;
        if (bytes > 2 * 1024 * 1024) throw invalid();
        return {id: message.id, role: message.role, text: message.text, turnId: message.turnId ?? undefined, timestamp: message.timestamp ?? undefined};
    });
    return {version: 1, session, revision: row.revision, messages, omittedUnclassified: row.omittedUnclassified, nextCursor: row.nextCursor};
}
function invalid(): FSError {return new FSError('EIO', 'Invalid provenance-filtered session digest', 'protocol');}
