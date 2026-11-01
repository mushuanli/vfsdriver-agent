import { afterEach,expect,it,vi } from 'vitest';
const rpc=vi.hoisted(()=>({call:vi.fn(),metadata:vi.fn(),close:vi.fn(async()=>{})}));
vi.mock('../src/harness/rpc',()=>({createHarnessRpc:()=>rpc}));
import { createCellsDriver } from '../src/provider';
const descriptor={version:1,fileProtocol:'fs-agent-http-v1',serverId:'personal',httpEndpoint:'./',harness:false,projects:true,projectProtocol:'fs-agent-project-v1'};
afterEach(()=>vi.resetAllMocks());
it.each(['itookit/cells'])('reuses %s discovery metadata without invoking a capability tool',async key=>{
    rpc.metadata.mockResolvedValue({[key]:descriptor});const driver=createCellsDriver();
    expect(await driver.discover({endpoint:'https://pi.test/mcp',credentialRef:'ref'})).toMatchObject({serverId:'personal'});
    expect(rpc.call).not.toHaveBeenCalled();await driver.dispose();
});
it('rejects an invalid advertised descriptor without probing a fallback tool',async()=>{
    rpc.metadata.mockResolvedValue({'itookit/cells':{...descriptor,httpEndpoint:'https://other.test'}});const driver=createCellsDriver();
    await expect(driver.discover({endpoint:'https://pi.test/mcp',credentialRef:'ref'})).rejects.toThrow('Invalid cells HTTP endpoint');
    expect(rpc.call).not.toHaveBeenCalled();await driver.dispose();
});
it('prefers the cells discovery tool and preserves the shared file protocol',async()=>{
    rpc.call.mockResolvedValue(descriptor);const driver=createCellsDriver();
    expect(await driver.discover({endpoint:'https://pi.test/mcp',credentialRef:'ref'})).toMatchObject({httpEndpoint:'https://pi.test',serverId:'personal'});
    expect(rpc.call).toHaveBeenCalledWith('cells_capabilities',{},undefined);expect(rpc.call).toHaveBeenCalledTimes(1);await driver.dispose();
});
it('reports an unavailable cells capability without trying legacy names',async()=>{
    rpc.call.mockRejectedValueOnce({remoteCode:'ECAPABILITY'});const driver=createCellsDriver();
    await expect(driver.discover({endpoint:'https://pi.test/mcp',credentialRef:'ref'})).rejects.toMatchObject({remoteCode:'ECAPABILITY'});
    expect(rpc.call).toHaveBeenCalledExactlyOnceWith('cells_capabilities',{},undefined);await driver.dispose();
});
it('keeps authentication and network errors visible without trying another name',async()=>{
    rpc.call.mockRejectedValueOnce(new Error('authentication failed'));const driver=createCellsDriver();
    await expect(driver.discover({endpoint:'https://pi.test/mcp',credentialRef:'ref'})).rejects.toThrow('authentication failed');expect(rpc.call).toHaveBeenCalledTimes(1);await driver.dispose();
});
