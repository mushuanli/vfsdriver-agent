import {describe,it,expect,vi} from 'vitest';
import {validateAuthorization,validateProjectCapabilities} from '../src/authorization';
import {HttpTransport} from '../src/files/transport';
import {createCellsDriver} from '../src/provider';
import {MCPProjectClient} from '../src/projects';
const authorization={principalId:'alice',anonymous:false,revision:'a'.repeat(64)};
const capabilities={fileRead:true,fileWrite:false,run:true,sessionRead:true,sessionControl:true};
describe('directory authorization contracts',()=>{
    it('validates identities and independent execution permissions',()=>{
        expect(validateAuthorization(authorization)).toEqual(authorization);
        expect(validateAuthorization(undefined)).toBeUndefined();
        for(const value of [{...authorization,anonymous:true},{...authorization,principalId:'../alice'},{...authorization,revision:'old'}])
            expect(()=>validateAuthorization(value)).toThrow('Invalid remote authorization');
        expect(validateProjectCapabilities(capabilities)).toEqual(capabilities);
        expect(()=>validateProjectCapabilities({...capabilities,run:false})).toThrow();
    });
    it('omits all ambient authentication for explicit anonymous access',async()=>{
        const credential=vi.fn(()=>{throw new Error('must not resolve credentials');});
        const fetch=vi.fn(async()=>Response.json({version:1,exports:[]}));
        const transport=new HttpTransport({endpoint:'https://files.test',anonymous:true,credential,fetch});
        await transport.json('v1/exports',{headers:{Authorization:'Bearer ambient'}});
        expect(new Headers(fetch.mock.calls[0][1]?.headers).has('authorization')).toBe(false);
        expect(credential).not.toHaveBeenCalled();transport.close();
    });
    it('binds every file request to the expected principal and grant revision',async()=>{
        const fetch=vi.fn(async()=>Response.json({ok:true}));
        const transport=new HttpTransport({endpoint:'https://files.test',credential:()=> 'fixture',authorization,fetch});
        await transport.json('v1/exports');
        const headers=new Headers(fetch.mock.calls[0][1]?.headers);
        expect(headers.get('x-cells-principal')).toBe('alice');
        expect(headers.get('x-cells-grant-revision')).toBe(authorization.revision);
        transport.close();
    });
    it('can discover an anonymous MCP node without resolving a secret',async()=>{
        const resolve=vi.fn(()=>{throw new Error('must not resolve credentials');});
        const fetch=vi.fn(async(_input:unknown,init?:RequestInit)=>{
            expect(new Headers(init?.headers).has('authorization')).toBe(false);
            const request=JSON.parse(String(init?.body));
            return Response.json({jsonrpc:'2.0',id:request.id,result:{resultType:'complete',ttlMs:0,cacheScope:'private',supportedVersions:['2026-07-28'],capabilities:{tools:{}},_meta:{'itookit/cells':{version:1,httpEndpoint:'./',fileProtocol:'fs-agent-http-v1',harness:false,serverId:'node',authorization:{...authorization,principalId:'anonymous',anonymous:true}}}}});
        });
        const driver=createCellsDriver(resolve,fetch as typeof globalThis.fetch);
        expect((await driver.discover({endpoint:'https://files.test/mcp',credentialRef:'public',anonymous:true})).authorization?.anonymous).toBe(true);
        expect(resolve).not.toHaveBeenCalled();await driver.dispose();
    });
    it('keeps readonly project file access separate from native conversation control',async()=>{
        const call=vi.fn(async()=>({epoch:'e',profiles:[{id:'codex',kind:'codex',projectRuntime:true,workspaces:[],capabilities:{history:true,create:true,resume:true,interrupt:true,interactions:true}}]}));
        const client=new MCPProjectClient({call,close:vi.fn()});
        const project={id:'p',name:'P',alias:'docs',path:'',access:'ro' as const,revision:1,mounts:[],capabilities};
        const profile=(await client.harness(project,{readOnly:true}).profiles()).profiles[0];
        expect(profile.capabilities.create).toBe(true);expect(profile.projectCapabilities?.fileWrite).toBe(false);
        const restricted=(await client.harness({...project,capabilities:{...capabilities,run:false,sessionControl:false}}).profiles()).profiles[0];
        expect(restricted.capabilities.create).toBe(false);expect(restricted.capabilities.history).toBe(true);
    });
});
