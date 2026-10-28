import {expect, it} from 'vitest';
import {responseError} from '../src/files/transport/errors';
it('preserves safe server failure codes without changing the VFS error vocabulary', async () => {
    const error = await responseError(new Response(JSON.stringify({code: 'METADATA_IO'}), {status: 500}));
    expect(error).toMatchObject({code: 'EIO', remoteCode: 'METADATA_IO', status: 500});
    expect(error.message).toContain('METADATA_IO');
    const unsafe = await responseError(new Response(JSON.stringify({code: 'private response content'}), {status: 500}));
    expect(unsafe.message).not.toContain('private response content');
});
