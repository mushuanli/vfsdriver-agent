export interface HarnessActivity {
    turnId: string;
    phase: 'working' | 'reasoning' | 'tool' | 'responding' | 'compacting';
    updatedAt?: number;
}

/** Presentation evidence only; it never changes execution state or queue admission. */
export class HarnessActivityTracker {
    private value?: HarnessActivity;
    private readonly tools = new Set<string>();
    snapshot(turnId?: string | null): HarnessActivity | undefined {
        if (!turnId || this.value?.turnId !== turnId) {this.value = undefined; this.tools.clear();}
        return this.value ? {...this.value} : undefined;
    }
    observe(method: string, params: Record<string, unknown>, at: number | undefined, turnId?: string | null): void {
        this.snapshot(turnId);
        if (!turnId || typeof params.turnId === 'string' && params.turnId !== turnId) return;
        if (!Number.isFinite(at) || at! <= 0 || this.value?.updatedAt && at! < this.value.updatedAt) return;
        const item = params.item as {id?: string; type?: string} | undefined;
        const phase = this.phase(method, item);
        if (phase) this.value = {turnId, phase: this.tools.size ? 'tool' : phase, updatedAt: at};
    }
    private phase(method: string, item?: {id?: string; type?: string}): HarnessActivity['phase'] | undefined {
        if (method === 'turn/started') return 'working';
        if (method.startsWith('item/reasoning/')) return 'reasoning';
        if (method === 'item/agentMessage/delta') return 'responding';
        if (!['item/started', 'item/completed'].includes(method) || !item?.type) return;
        if (/Execution|Change|[Tt]oolCall|webSearch|imageGeneration/.test(item.type)) {
            if (item.id) {if (method === 'item/started') this.tools.add(item.id); else this.tools.delete(item.id);}
            return method === 'item/started' ? 'tool' : 'working';
        }
        if (method === 'item/completed') return 'working';
        return item.type === 'reasoning' ? 'reasoning' : item.type === 'agentMessage' ? 'responding'
            : item.type === 'contextCompaction' ? 'compacting' : undefined;
    }
}
